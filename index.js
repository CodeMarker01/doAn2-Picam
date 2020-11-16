// API & hide API
require("dotenv").config();
const VONAGE_API_KEY = process.env.VONAGE_API_KEY
const VONAGE_API_SECRET = process.env.VONAGE_API_SECRET
const TO_NUMBER = process.env.VONAGE_TO_NUMBER
const VONAGE_BRAND_NAME = process.env.VONAGE_BRAND_NAME
// Web server w/ express
const express = require('express');
const https = require('https')
const fs = require('fs');
const gpio = require('onoff').Gpio;
const path = require('path');

// model: application <-access-> database
const db = require('./models/index');

// stream video to browser
const OpenTok = require('opentok');
const puppeteer = require('puppeteer');

// remote control: over the internet
const ngrok = require('ngrok');

// Vonage messages
const Vonage = require('nexmo');

const app = express();
const pir = new gpio(18, 'in', 'both');

const opentok = new OpenTok(
    process.env.VONAGE_VIDEO_API_KEY,
    process.env.VONAGE_VIDEO_API_SECRET,
);
let canCreateSession = true;
let session = null;
var url = null;

const vonage = new Vonage({
  apiKey: process.env.VONAGE_API_KEY,
  apiSecret: process.env.VONAGE_API_SECRET,
  applicationId: process.env.VONAGE_APPLICATION_ID,
  privateKey: process.env.VONAGE_APPLICATION_PRIVATE_KEY_PATH,
});

// Session Section
async function createSession() {
    opentok.createSession({ mediaMode: 'routed' }, (error, session) => {
      if (error) {
        console.log(`Error creating session:${error}`);
   
        return null;
      }
   
      createSessionEntry(session.sessionId);
      sendSMS();
      startPublish();
      return null;
    });
};
   
function createSessionEntry(newSessionId) {
    db.Session
      .create({
        sessionId: newSessionId,
        active: true,
      })
      .then((sessionRow) => {
        session = sessionRow;
   
        return sessionRow.id;
    });
};

async function closeSession(currentPage, currentBrowser) {
    console.log('Time limit expired. Closing stream');
    await currentPage.close();
    await currentBrowser.close();
   
    if (session !== null) {
      session.update({
        active: false
      });
    }
}

// Publish Section: server & client
async function startPublish() {
    // Create a new browser using puppeteer
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: 'chromium-browser',
      ignoreHTTPSErrors: true,
      args: [
        '--ignore-certificate-errors',
        '--use-fake-ui-for-media-stream',
        '--no-user-gesture-required',
        '--autoplay-policy=no-user-gesture-required',
        '--allow-http-screen-capture',
        '--enable-experimental-web-platform-features',
        '--auto-select-desktop-capture-source=Entire screen',
      ],
    });
   
    // Creates a new page for the browser
    const page = await browser.newPage();
   
    const context = browser.defaultBrowserContext();
    await context.overridePermissions('https://localhost:3000', ['camera', 'microphone']);
   
    await page.goto('https://localhost:3000/serve');
   
    let sessionDuration = parseInt(process.env.VIDEO_SESSION_DURATION);
    let sessionExpiration = sessionDuration + 10000;
   
    // Closes the video session / browser instance when the predetermined time has expired
    setTimeout(closeSession, sessionDuration, page, browser);
   
    // Provides a buffer between the previous stream closing and when the next can start if motion is detected
    setTimeout(() => { canCreateSession = true; }, sessionExpiration);
}

// remote control using ngrok
async function connectNgrok() {
    url = await ngrok.connect({
      proto: 'http',
      addr: 'https://192.168.2.101:3000/',
      region: 'eu',
      // The below examples are if you have a paid subscription with Ngrok where you can specify which subdomain
      //to use and add the location of your configPath. For me, it was gregdev which results in
      //https://gregdev.eu.ngrok.io, a reserved subdomain
      // subdomain: 'gregdev',
      // configPath: '/home/pi/.ngrok2/ngrok.yml',
      authtoken: process.env.NGROK_AUTH_TOKEN,
      onStatusChange: (status) => { console.log(`Ngrok Status Update:${status}`); },
      onLogEvent: (data) => { console.log(data); },
    });
   
    fs.writeFile('public/config/config.txt', url, (err) => {
      if (err) throw err;
      console.log('The file has been saved!');
    });

    vonage.applications.update(process.env.VONAGE_APPLICATION_ID, {
        name: process.env.VONAGE_BRAND_NAME,
        capabilities: {
          messages: {
            webhooks: {
              inbound_url: {
                address: `${url}/webhooks/inbound-message`,
                http_method: 'POST',
              },
              status_url: {
                address: `${url}/webhooks/message-status`,
                http_method: 'POST',
              },
            },
          },
        },
      },
      (error, result) => {
        if (error) {
          console.error(error);
        } else {
          console.log(result);
        }
      });
}

// Sending an SMS
function sendSMS() {
    const message = {
      content: {
        type: 'text',
        text: `Motion has been detected on your camera, please view the link here: ${url}/client '`,
      },
    };
   
    vonage.channel.send(
      { type: 'sms', number: process.env.TO_NUMBER },
      { type: 'sms', number: process.env.VONAGE_BRAND_NAME },
      message,
      (err, data) => {
          if(err) {
              console.log("message failed with error:", err);
          } else {
            console.log(`Message ${data.message_uuid} sent successfully.`);
          }},
      { useBasicAuth: true },
    );
}

//web server
async function startServer() {
    const port = 3000;

    app.get('/', (req, res) => {
        res.json({message: 'Welcome to my Webserver'});
    });

    app.use(express.static(path.join(`${__dirname}/public`)));

    app.get('/serve', (req, res) => {
        res.sendFile(path.join(`${__dirname}/public/server.html`));
    });

    app.get('/client', (req, res) => {
        res.sendFile(path.join(`${__dirname}/public/client.html`));
    });

    app.get('/get-details', (req, res) => {
        db.Session.findAll({
            limit: 1,
            where: {
                active: true,
            },
            order: [['createdAt', 'DESC']],
        }).then((entries) => res.json({
            sessionId: entries[0].sessionId,
            token: opentok.generateToken(entries[0].sessionId),
            apiKey: process.env.VONAGE_VIDEO_API_KEY,
        }));
    });

    const httpServer = https.createServer({
        key: fs.readFileSync('./key.pem'),
        cert: fs.readFileSync('./cert.pem'),
        passphrase: 'quangloi',
    }, app);

    httpServer.listen(port, (err) => {
        if(err) {
            return console.log(`Unable to start server: ${err}`);
        }
        connectNgrok();
        return true;
    });
}
startServer();

 // Motion Sensor
pir.watch(function(err, value) {
    if (value == 1) {
        if (value ===1 && canCreateSession=== true) {
            canCreateSession = false;
            console.log('Motion Detected!');

            createSession();
        }
    } else {
        console.log('Motion Stopped');
    }
});

// const Vonage = require('@vonage/server-sdk')

// const vonage = new Vonage({
//   apiKey: VONAGE_API_KEY,
//   apiSecret: VONAGE_API_SECRET
// });

// const from = VONAGE_BRAND_NAME
// const to = TO_NUMBER
// const text = 'A text message sent using the Vonage SMS API'

// vonage.message.sendSms(from, to, text, (err, responseData) => {
//     if (err) {
//         console.log(err);
//     } else {
//         if(responseData.messages[0]['status'] === "0") {
//             console.log("Message sent successfully.");
//         } else {
//             console.log(`Message failed with error: ${responseData.messages[0]['error-text']}`);
//         }
//     }
// })