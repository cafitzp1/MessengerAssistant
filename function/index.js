'use strict';
var request = require('request');
var xml2js = require('xml2js');
var xmlParser = new xml2js.Parser({explicitArray: false, mergeAttrs : true});
var request = require('request');
var verifyToken = 'eLUqm93Fe9ZSV8VG2yFAJkgrb';
var appVersion = '1.0.1.3';

// main entry point for the application
exports.handler = (event, context, callback) => {
    console.log('*ENTRY - exports.handler*');
    console.log(`*Event: ${JSON.stringify(event)}*`);
    console.log(`*Context: ${JSON.stringify(context)}*`);

    // entry point for GET/POST requests
    if(event.params && event.params.querystring) {
        console.log('--< Request received');

        // parse query params
        let queryParams = event.params.querystring;
        let token = queryParams['hub.verify_token'];
        let challenge = queryParams['hub.challenge'];

        // check if mode and token sent is correct
        if (token === verifyToken) {
            // respond with the challenge token from the request
            console.log('--> Webhook verified');
            callback(null, parseInt(challenge));
        } else {
            var response = {
                'body': 'UNPROCESSABLE ENTITY',
                'statusCode': 422
            };
            console.log('--> 422 UNPROCESSABLE ENTITY');
            callback(null, response);
        }

    // this entry is for the POST request
    } else {
        console.log('--< Request received');

        let body = event.body;
        console.log(JSON.stringify(body));

        // check if this is an event from a page subscription
        if(body.object === 'page') {

            // iterate over each entry (may be multiple if batched)
            body.entry.forEach(function(entry) {
                routeHTTPRequest(entry);
            });

            // return '200 OK' response if ok
            let response = {
                'body': "OK",
                'statusCode': 200
            };

            // respond with '200 OK'
            callback(null, response);
        } else {
            // return '403 FORBIDDEN' response if not ok
            let response = {
                'body': "FORBIDDEN",
                'statusCode': 403
            };

            callback(null, response);
            console.log('--> 403 FORBIDDEN');  
        }
    }
};

// route event to appropriate handler
function routeHTTPRequest(entry) {
    // get message. entry.messaging and entry.standby? (check this) array will only ever contain a single message
    let webhook_event;

    if(entry.messaging==null) { 
        console.log('Entry.messaging array null');
        if(entry.standby==null) {
            console.log('--> Entry.standby array null');
            return;
        } else {
            // standby event occurred; pass event
            console.log('Entry has standby; routing to standby handler:');
            webhook_event = entry.standby[0];
            onStandby(webhook_event.sender.id, entry.id, webhook_event.message);
            return;
        }
    }
    webhook_event = entry.messaging[0];

    // log
    console.log("Request body:");
    console.log(webhook_event);

    // pass event to appropriate handler
    if (webhook_event.message) {
        console.log('Routing to message handler');
        onMessage(webhook_event.sender.id, entry.id, webhook_event.message);
    } else if (webhook_event.postback) {
        console.log('Routing to postback handler');
        onPostback(webhook_event.sender.id, entry.id, webhook_event.postback);
    } else if (webhook_event.pass_thread_control) {
        console.log("--> Handover event does not require action.");
    } else {
        console.log("--> Unrecognized event; no further action taken.");
    }
}
function onMessage(sender_psid, recipient_id, received_message) { 
    // return if media content
    if (received_message.attachments) {
        sendAPI(sender_psid, recipient_id, {"text": "Well this is awkward... My programmer has not yet taught me how to understand anything other than simple dialog. My apologies."});
        return;
    }
    console.log(received_message);
    generateApiaiResponse(sender_psid, recipient_id, received_message);
}
function onPostback(sender_psid, recipient_id, received_postback) {
    // if something went wrong and there's no payload then return
    if (!received_postback.payload) return;
    let message = received_postback.payload; 

    // route to processor if flagged
    if (message.startsWith('~')) { 
        message = message.replace('~', '');
        console.log('Routing payload to processor');
        processAgentInstruction (sender_psid, recipient_id, message);
    }
    else {
        console.log('Routing payload to agent');

        // construct received_message request json
        let json = { mid:
            'CISsviX96MPx9xRze3oTqr-ChpCiCfbrFLWPHfMUpNwyAyd3pFfiGpJ371Yinv73ED83mL_Em2glQoLICrbBMg',
        seq: 3998,
        text: message };
        
        // route to onMessage
        onMessage(sender_psid, recipient_id, json);
    }
}
function onStandby(sender_psid, recipient_id, received_message) {
    // take back control if keyword is received
    console.log(received_message);

    if(received_message==null || !received_message.hasOwnProperty('text') || received_message.text==null) {
        console.log('--> Standby had no text');
        return;
    }

    if(received_message.text=='stop' || received_message.text=="Stop")
    {
        // client wants the bot back. route to take thread control
        take_thread_controlJSONconstructor(sender_psid, recipient_id);
    } else {
        console.log('--> No call to take back control');
    }
}

// request instruction from assigned agent
function generateApiaiResponse(sender_psid, recipient_id, received_message) {
    console.log('Requesting agent instruction');

    // get client access token for recipient
    let pageAccessToken = returnPageAccessToken(recipient_id);
    let clientAccessToken = returnClientAccessToken(recipient_id);
    let sessionID = returnPageName(recipient_id);

    // return and log error if tokens are -1
    if (pageAccessToken == null || pageAccessToken == -1 || clientAccessToken == null || clientAccessToken == -1) {
        console.log("--! ERROR: page access token or client access token values missing");
        return;
    }

    // generate response from agent for this particular client
    let message = received_message.text;
    let apiaiClient = require('apiai')(clientAccessToken);
    let apiaiSession = apiaiClient.textRequest(message, {sessionId: sessionID});

    // pass instruction to processor function
    apiaiSession.on('response', (response) => {
        let instruction = response.result.fulfillment.speech;
        processAgentInstruction(sender_psid, recipient_id, instruction); 
    });
    
    // on error, prompt and return
    apiaiSession.on('error', error => { 
        console.log(`--! ERROR: ${error}`);
        apiaiSession.end();
        return;
    });

    apiaiSession.end();
}

// process agent instruction, route to appropriate JSON constructor or API
function processAgentInstruction (sender_psid, recipient_id, instruction) {
    console.log('Instruction received:');
    console.log(`  '${instruction}'`);
    let data;

    // check if the instruction is a command before trying to parse XML
    if (instruction[0]=='`') {
        console.log('Instruction is command');

        // at this state, commands are just more or less for testing purposes
        if (instruction.startsWith('`img')) {
            console.log('Routing to image JSON constructor');
            imageJSONconstructor(sender_psid, recipient_id, instruction);
        } else if (instruction.startsWith('`version')) {
            console.log('Routing test version to sendAPI');
            sendAPI(sender_psid, recipient_id, returnTextJSON(appVersion));
        }

        return;
    }

    // attempt XML parse
    xmlParser.parseString(instruction, function(err, result) {
        data = result;
        return;
    });

    // if no data, the instruction cannot be processed as xml
    if(data==null) {
        let char;
        if(instruction!=null && instruction!="") char = instruction[0];
        else {
            console.log('--! ERROR: Agent instruction null/empty');
            return;
        }

        if (char!='<' && char!='_' && char!='`') {
            console.log('Instruction is standard reply; routing directly to sendAPI');
            let message_body = returnTextJSON(instruction);
            sendAPI(sender_psid, recipient_id, message_body);
            return;
        } else {
            console.log('ERROR: Irregular format detected but could not parse; replying with a fallback');
            let message_body = returnTextJSON("I'm sorry, there was a problem processing that request...");
            sendAPI(sender_psid, recipient_id, message_body);
            return;
        }
    }
    
    // instruction is XML
    console.log('Instruction is XML');

    if(data.hasOwnProperty('message')) {
        console.log('XML is message_body; routing directly to sendAPI');
        sendAPI(sender_psid, recipient_id, data.message);
    } else if(data.hasOwnProperty('response')) {
        console.log('XML is for a response');
        // route data based on tag within response
        if(data.response.hasOwnProperty('text')) {
            console.log('Response = text; routing to text JSON constructor');
            textJSONconstructor(sender_psid, recipient_id, data);
        } else if (data.response.hasOwnProperty('text_qr')) {
            console.log('Response = text_qr; routing to text_qr JSON constructor');
            text_qrJSONconstructor(sender_psid, recipient_id, data);
        } else if (data.response.hasOwnProperty('button_template')) {
            console.log('Response = button_template; routing to button_template JSON constructor');
            button_templateJSONconstructor(sender_psid, recipient_id, data);
        } else if (data.response.hasOwnProperty('image')) {
            console.log('Response = image; routing to image JSON constructor');
            imageJSONconstructor(sender_psid, recipient_id, data);
        } else if (data.response.hasOwnProperty('image_buttons')) {
            console.log('Response = image_buttons; routing to image_buttons JSON constructor');
            image_buttonsJSONconstructor (sender_psid, recipient_id, data);
        } else if (data.response.hasOwnProperty('generic_template')) {
            console.log('Response = generic_template; routing to generic_template JSON constructor');
            generic_templateJSONconstructor(sender_psid, recipient_id, data);
        } else if (data.response.hasOwnProperty('list_template')) {
            console.log('Response = list_template; routing to list_template JSON constructor');
            list_templateJSONconstructor(sender_psid, recipient_id, data);
        } else {
            console.log('ERROR: response XML property was unrecognized; replying with a fallback');
            let message_body = returnTextJSON("I'm sorry, there was a problem processing that request...");
            sendAPI(sender_psid, recipient_id, message_body);
        }
    } else if (data.hasOwnProperty('task')) {
        console.log('XML is for a task');
        // route data based on tag within task
        if(data.task.hasOwnProperty('handover')) {
            console.log('Task = handover; routing to handover JSON constructor');
            pass_thread_controlJSONconstructor(sender_psid, recipient_id, data);
        } else {
            console.log('ERROR: task XML property was unrecognized; replying with a fallback');
            let message_body = returnTextJSON("I'm sorry, there was a problem processing that request...");
            sendAPI(sender_psid, recipient_id, message_body);
        }
    } else if (data.hasOwnProperty('test')) {
        console.log('XML is for a test');
        sendAPI(sender_psid, recipient_id, returnTextJSON(appVersion));
    } else {
        console.log('ERROR: No XML intent detected; replying with a fallback');
        let message_body = returnTextJSON("I'm sorry, there was a problem processing that request...");
        sendAPI(sender_psid, recipient_id, message_body);
    }
}

// construct JSON and route to API function
function textJSONconstructor (sender_psid, recipient_id, data) {
    let payload;
    let text;

    // text can be stored in xml or by itself (standard reply)
    if (typeof data == 'object') {
        text = data.response.text;
    } else {
        text = data;
    }

    // construct
    payload = returnTextJSON(text);

    // route to sendAPI
    sendAPI(sender_psid, recipient_id, payload);
}
function text_qrJSONconstructor (sender_psid, recipient_id, data) {
    let payload;
    let xml = data.response.text_qr;
    let quick_replies = [];

    // fix data
    if(Array.isArray(xml.quick_replies)) {
        quick_replies = xml.quick_replies;
    } else {
        quick_replies.push(xml.quick_replies);
    }

    // construct
    payload = {
        "text": xml.text,
        "quick_replies": quick_replies
    };

    // route to sendAPI
    sendAPI(sender_psid, recipient_id, payload);
}
function button_templateJSONconstructor (sender_psid, recipient_id, data) {
    let payload;
    let xml = data.response.button_template;
    let text = xml.text;
    let buttons = [];

    //fix data
    if(Array.isArray(xml.buttons)) {
        buttons=xml.buttons;
    } else {
        buttons.push(xml.buttons);
    }

    // construct
    payload = {
        "attachment": {
            "type": "template",
            "payload": {
                "template_type": "button",
                "text": text,
                "buttons": buttons         
            }
        }
    };

    // route to sendAPI
    sendAPI(sender_psid, recipient_id, payload);
}
function imageJSONconstructor (sender_psid, recipient_id, data) {
    let payload;

    // data can be xml or command
    if (typeof data == 'object') {
        let xml = data.response.image;
        let fbURL = xml.url;
        payload = {
            "attachment": {
                "type": "template",
                "payload": {
                    "template_type": "media",
                    "elements": [
                        {
                            "media_type": "image",
                            "url": fbURL
                        }
                    ]
                }
            }     
        };
    } else {
        // exract url
        let content = String(data); 
        let delim = content.indexOf("=")+1;
        let url = content.substring(delim);

        payload = {
            "attachment": {
                "type": "template",
                "payload": {
                    "template_type": "media",
                    "elements": [
                        {
                            "media_type": "image",
                            "url": url,
                        }
                    ]
                }
            }     
        };
    }

    sendAPI(sender_psid, recipient_id, payload);
}
function image_buttonsJSONconstructor (sender_psid, recipient_id, data) {
    let payload;
    let xml = data.response.image_buttons;
    let fbURL = xml.url;
    let buttons = [];
    
    // fix data
    if(Array.isArray(xml.buttons)) {
        buttons=xml.buttons;
    } else {
        buttons.push(xml.buttons);
    }

    // construct
    payload = {
        "attachment": {
            "type": "template",
            "payload": {
                "template_type": "media",
                "elements": [
                    {
                        "media_type": "image",
                        "url": fbURL,
                        "buttons": buttons
                    }
                ]
            }
        }     
    };

    // route to api
    sendAPI(sender_psid, recipient_id, payload);
}
function generic_templateJSONconstructor (sender_psid, recipient_id, data) {
    let payload;
    let elements = returnGtElementsJSON(data.response.generic_template);

    // arrays are parsed in returnGtElements function
    payload = {
        "attachment": {
            "type": "template",
            "payload": {
                "template_type": "generic",
                "elements": elements
            }
        }     
    };

    sendAPI(sender_psid, recipient_id, payload);
}
function list_templateJSONconstructor (sender_psid, recipient_id, data) {
    let payload;
    let list_template = data.response.list_template;
    let elements = returnListElementsJSON(list_template);
    let top_element_style = list_template.top_element_style; // compact (default) or large
    let buttons = list_template.buttons;
    let buttonsArr = [];

    // optional
    if (buttons) {
        // fix data
        if (Array.isArray(buttons)) {
            buttonsArr = buttons;
        } else {
            buttonsArr.push(buttons);
        }
    }

    // other arrays are parsed in returnListElements function
    payload = {
        "attachment": {
            "type": "template",
            "payload": {
                "template_type": "list",
                "top_element_style": top_element_style,
                "elements": elements
            }
        }     
    };

    // add optional data
    if (buttonsArr && buttonsArr.length>0) {
        payload.attachment.payload.buttons = buttonsArr;
    }

    sendAPI(sender_psid, recipient_id, payload);
}
function pass_thread_controlJSONconstructor (sender_psid, recipient_id, data) {
    // construct pass_thread_control post body
    let pass_thread_control_body = {
        "recipient": {
            "id": sender_psid
        },
        "target_app_id": "263902037430900"
    };

    // send HTTP request to pass thread control
    passThreadControl(sender_psid, recipient_id, pass_thread_control_body, data);
}
function take_thread_controlJSONconstructor (sender_psid, recipient_id) {
    // construct take_thread_control post body
    let take_thread_control_body = {
        "recipient": {
            "id": sender_psid
        }
    };

    // send HTTP request to take thread control
    takeThreadControl(sender_psid, recipient_id, take_thread_control_body);
}

// post to appropriate API
function sendAPI (sender_psid, recipient_id, message_body) {
    console.log('Posting via sendAPI');

    let request_body = {
        "recipient": {
            "id": sender_psid
        },
        "message": message_body
    };
    
    // construct typing on body
    let typingOnJSON = {
        "recipient": {
            "id": sender_psid
        },
        "sender_action": "typing_on"
    };

    // get page access token for recipient
    let pageAccessToken = returnPageAccessToken(recipient_id);
    
    if(pageAccessToken==null || pageAccessToken==-1) {
        console.log("--! ERROR: page access token not found");
        return;
    }

    // display typing bubble
    request({
        "uri": "https://graph.facebook.com/v2.6/me/messages",
        "qs": { "access_token": pageAccessToken },
        "method": "POST",
        "json": typingOnJSON
    }, (err, res, body) => {
        if (!err) {
            // send HTTP request
            request({
                "uri": "https://graph.facebook.com/v2.6/me/messages",
                "qs": { "access_token": pageAccessToken },
                "method": "POST",
                "json": request_body
            }, (err, res, body) => {
                if (!err) {
                    console.log("POST body:");
                    console.log(request_body);
                    console.log("--> Response sent");
                } else { 
                    console.error(`--! ERROR: ${err}`);
                }
            });
        } else { 
            console.error(`--! ERROR: ${err}`);
        }
    });
}
function passThreadControl (sender_psid, recipient_id, request_body, data) {
    console.log('Posting via handoverProtocolAPI (pass_thread_control)');

    // get page access token for recipient
    let pageAccessToken = returnPageAccessToken(recipient_id);
    let handover = data.task.handover;
    let message;

    // determine whether to use optionally provided message or default
    if(handover.hasOwnProperty('text')) {
        console.log('Replying with custom message');
        message = handover.text;
    } else {
        console.log('Replying with default message');
        message = "Okay. From here on out, your messages will be sent directly to the owner of this page. Reply 'Stop' if you would like me to come back. Until next time!";
    }

    request({
        "uri": "https://graph.facebook.com/v2.6/me/pass_thread_control",
        "qs": { "access_token": pageAccessToken },
        "method": "POST",
        "json": request_body
    }, (err, res, body) => {
        if (!err) {
            console.log("POST body:");
            console.log(request_body);
            console.log("Control passed to agent");
            sendAPI(sender_psid, recipient_id, {"text": message});
        } else { 
            console.error(`--! ERROR: ${err}`);
            console.log();
        }
    });
}
function takeThreadControl (sender_psid, recipient_id, request_body) {
    console.log('Posting via handoverProtocolAPI (take_thread_control)');

    // get page access token for recipient
    let pageAccessToken = returnPageAccessToken(recipient_id);

    // construct a request for getting agent specific control returned instruction
    let controlReturnedRequest = { mid:
        'CISsviX96MPx9xRze3oTqr-ChpCiCfbrFLWPHfMUpNwyAyd3pFfiGpJ371Yinv73ED83mL_Em2glQoLICrbBMg',
        seq: 3998,
        text: "!rtc" 
    };

    request({
        "uri": "https://graph.facebook.com/v2.6/me/take_thread_control",
        "qs": { "access_token": pageAccessToken },
        "method": "POST",
        "json": request_body
    }, (err, res, body) => {
        if (!err) {
            console.log("POST body:");
            console.log(request_body);
            console.log("Control returned to assistant");

            // route request to onMessage so that we can get our agent instruction
            console.log('Requesting control_returned instruction from agent');
            onMessage(sender_psid, recipient_id, controlReturnedRequest);
        } else { 
            console.error(`--! ERROR: ${err}`);
            console.log();
        }
    });
}
function attachmentUploadAPI (sender_psid, recipient_id, responseJSON) {
    console.log('*ENTRY - handoverProtocolAPI*');

    // get page access token for recipient
    let pageAccessToken = returnPageAccessToken(recipient_id);

    request({
        "uri": "https://graph.facebook.com/v2.6/me/pass_thread_control",
        "qs": { "access_token": pageAccessToken },
        "method": "POST",
        "json": responseJSON
    }, (err, res, body) => {
        if (!err) {
            console.log("POST body:");
            console.log(responseJSON);
            console.log("--> Control passed to agent");
            sendAPI(sender_psid, recipient_id, {"text": "Okay. From here on out, you're messages will be sent directly to the owner of this page. Until next time!"});
        } else { 
            console.error(`--! ERROR: ${err}`);
            console.log();
        }
    });
}

// helper functions
function returnPageAccessToken (recipient_id) {
    var pages = require('pages');
    var pagesJSONString = JSON.stringify(pages);
    var pagesJSONData = JSON.parse(pagesJSONString);

    for (var i = 0; i < pagesJSONData.pages.length; i++) {
        var page = pagesJSONData.pages[i];
        if (page.pageID==recipient_id) {
            return page.pageAccessToken;
        }
    }
    return -1;
}
function returnClientAccessToken (recipient_id) {
    var pages = require('pages');
    var pagesJSONString = JSON.stringify(pages);
    var pagesJSONData = JSON.parse(pagesJSONString);

    for (var i = 0; i < pagesJSONData.pages.length; i++) {
        var page = pagesJSONData.pages[i];
        if (page.pageID==recipient_id) {
            return page.clientAccessToken;
        }
    }
    return -1;
}
function returnPageName (recipient_id) {
    var pages = require('pages');
    var pagesJSONString = JSON.stringify(pages);
    var pagesJSONData = JSON.parse(pagesJSONString);

    for (var i = 0; i < pagesJSONData.pages.length; i++) {
        var page = pagesJSONData.pages[i];
        if (page.pageID==recipient_id) {
            return page.pageName;
        }
    }
    return -1;
}
function returnTextJSON (text) {
    let json = {"text": text};
    return json;
}
function returnGtElementsJSON (generic_template) {
    let elements = generic_template.elements;
    let elementsArr = [];

    if(Array.isArray(elements)) {
        for(let i = 0; i<elements.length; i++) {
            let element = returnGtElementJSON(elements[i]);
            elementsArr.push(element);
        }
    } else {
        // elements only contains 1 item
        let element = returnGtElementJSON(elements);
        elementsArr.push(element);
    }

    return elementsArr;
}
function returnGtElementJSON (element) {
    let payload;
    let title = element.title; 
    let image_url = element.image_url; 
    let subtitle = element.subtitle;
    let buttonsArr = [];

    // fix data
    if (Array.isArray(element.buttons)) {
        buttonsArr = element.buttons;
    } else {
        buttonsArr.push(element.buttons);
    }

    // construct based on optional data
    if(element.hasOwnProperty('default_action')) {
        let default_action = element.default_action;
        payload = {
            "title": title,
            "image_url": image_url,
            "subtitle": subtitle,
            "default_action": default_action,
            "buttons": buttonsArr 
        };
    } else {
        payload = {
            "title": title,
            "image_url": image_url,
            "subtitle": subtitle,
            "buttons": buttonsArr 
        };
    }

    // return
    return payload;
}
function returnListElementsJSON (list_template) {
    let elements = list_template.elements;
    let elementsArr = [];

    if(Array.isArray(elements)) {
        for(let i = 0; i<elements.length; i++) {
            let element = returnListElementJSON(elements[i]);
            elementsArr.push(element);
        }
    } else {
        // elements only contains 1 item
        let element = returnListElementJSON(elements);
        elementsArr.push(element);
    }

    return elementsArr;
}
function returnListElementJSON (element) {
    let payload;

    // always required
    let title = element.title;

    // optional
    let subtitle = element.subtitle;
    let image_url = element.image_url;
    let default_action = element.default_action;
    let buttons = element.buttons;
    let buttonsArr = [];

    if (buttons) {
        // fix data
        if (Array.isArray(buttons)) {
            buttonsArr = buttons;
        } else {
            buttonsArr.push(buttons);
        }
    }

    // construct JSON
    payload = {
        "title": title,
    };

    // add optional properties
    if(subtitle) payload.subtitle = subtitle;
    if(image_url) payload.image_url = image_url;
    if(default_action) payload.default_action = default_action;
    if(buttonsArr && buttonsArr.length>0) payload.buttons = buttonsArr;

    // return
    return payload;
}