# Messenger Assistant for Facebook Messenger Platform

## What is it?

> Messenger Assistant is a network of chat bots for any number Facebook pages. 
> Each page has its own bot assigned, each fully customizable. 
> Responses can use any combination of the available templates available on the messenger platform. 
> Inbox control can be handed back over to the page owner at any point if the message sender requests.

----
## How does it work?

<!-- orig size: 480x268 ratio: 1.8 -->
<img src="https://media.giphy.com/media/TgMKRdvCi7Cb2bTIzr/giphy.gif" alt="Processing a request" width="540" height="300" />

5 Core Components 

Webhook event is received by the application (user sends a message or clicks a button)

* Production app uses AWS Lambda function registered to the webhook events
* Test app (shown in the screencasts) uses a local express server 

Event is routed to its appropriate handler

* Most events are messages and are therefore sent to a message event handler
* Message contents undergo some validation before proceeding (making sure no media is in the message as this messes with the next step)

Instruction is requested from assigned “agent” by providing message text

* An API is used for managing NLP
* This API acts as the “bot” of the program; intent(s) of the message get extracted, and instructions are sent back to the program accordingly
* Each page inbox a message originated from has its own “agent” responsible for providing instruction on how to proceed with responding to the message
* Instruction is more than just a text response¬—instruction is data for putting together a structured response (text and quick replies, buttons, images, templates, etc.)

POST Request body is constructed according to instruction

* Instruction is sent in XML to make it easy for the program to parse the data
* XML is more or less converted to JSON and the particular post request required for making, say, a button template appear in messenger is put together

![XML Response](https://i.imgur.com/XQDFS3I.png "XML Response")

Data is routed to the appropriate function responsible for executing POST request

* Usually posting via the send API but also handover protocol pass_thread_control and take_thread_control
* APIs generally use sender_psid (sender of the message), recipient_id (page inbox that received the message), and stored page authentication tokens for managed pages to ensure response gets back to the correct location


[github-repo](https://github.com/cafitzp1/MessengerAssistant)
