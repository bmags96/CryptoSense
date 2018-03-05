
/*ƒ*
 * Copyright 2015 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

require( 'dotenv' ).config( {silent: true} );

var express = require( 'express' );  // app server
var bodyParser = require( 'body-parser' );  // parser for post requests
var watson = require( 'watson-developer-cloud' );  // watson sdk
var watsonDiscovery = require('watson-developer-cloud/discovery/v1'); // watson discovery sdk

// The following requires are needed for logging purposes
var uuid = require( 'uuid' );
var vcapServices = require( 'vcap_services' );
var basicAuth = require( 'basic-auth-connect' );
var http = require( 'https' );

// The app owner may optionally configure a cloudand db to track user input.
// This cloudand db is not required, the app will operate without it.
// If logging is enabled the app must also enable basic auth to secure logging
// endpoints
var cloudantCredentials = vcapServices.getCredentials( 'cloudantNoSQLDB' );
var cloudantUrl = null;
if ( cloudantCredentials ) {
  cloudantUrl = cloudantCredentials.url;
}
cloudantUrl = cloudantUrl || process.env.CLOUDANT_URL; // || '<cloudant_url>';
var logs = null;
var app = express();

// Bootstrap application settings
app.use( express.static( './public' ) ); // load UI from public folder
app.use( bodyParser.json() );

// Create the service wrapper
var conversation = watson.conversation( {
  url: 'https://gateway.watsonplatform.net/conversation/api',
  username: process.env.CONVERSATION_USERNAME || '<username>',
  password: process.env.CONVERSATION_PASSWORD || '<password>',
  version_date: '2016-07-11',
  version: 'v1'
} );

var discovery = new watsonDiscovery({
  url: process.env.DISCOVERY_URL,
  username: process.env.DISCOVERY_USERNAME || '<username>',
  password: process.env.DISCOVERY_PASSWORD || '<password>',
  version_date: process.env.VERSION_DATE,
  version: 'v1'
});

// Endpoint to be call from the client side
app.post( '/api/message', function(req, res) {
  var workspace = process.env.WORKSPACE_ID || '<workspace-id>';
  if ( !workspace || workspace === '<workspace-id>' ) {
    return res.json( {
      'output': {
        'text': 'The app has not been configured with a <b>WORKSPACE_ID</b> environment variable. Please refer to the ' +
        '<a href="https://github.com/watson-developer-cloud/conversation-simple">README</a> documentation on how to set this variable. <br>' +
        'Once a workspace has been defined the intents may be imported from ' +
        '<a href="https://github.com/watson-developer-cloud/conversation-simple/blob/master/training/car_workspace.json">here</a> in order to get a working application.'
      }
    } );
  }
  var payload = {
    workspace_id: workspace,
    context: {},
    input: {}
  };
  if ( req.body ) {
    if ( req.body.input ) {
      payload.input = req.body.input;
    }
    if ( req.body.context ) {
      // The client must maintain context/state
      payload.context = req.body.context;
    }
  }
  // Send the input to the conversation service
  conversation.message( payload, function(err, data) {
    if ( err ) {
      return res.status( err.code || 500 ).json( err );
    }
    updateMessage( res, payload, data );
  } );
} );

/**
 * Updates the response text using the intent confidence
 * @param  {Object} res The node.js http response object
 * @param  {Object} input The request to the Conversation service
 * @param  {Object} response The response from the Conversation service
 * @return {Object}          The response with the updated message
 */
function updateMessage(res, input, response) {
  if ( !response.output ) {
    response.output = {};
  } else if ( checkCurrency( response ) ) {
    var currency = response.context.currency;
    if (currency === ( 'BTC' ) ) {
      currency = 'bitcoin';
    } else if (currency === ('ETH')) {
      currency = 'ethereum';
    } else if (currency === ('BCH')) {
      currency = 'bitcoin-cash';
    } else if (currency === ('XRP')) {
      currency = 'ripple';
    } else if (currency === ('LTC')) {
      currency = 'litecoin';
    }


    if ( checkPrice( response ) ) {
      var options = getPriceURL( currency );

      http.get( options, function(resp) {
        var chunkText = '';
        resp.on( 'data', function(chunk) {
          chunkText += chunk.toString( 'utf8' );
        } );

        resp.on( 'end', function() {
          var chunkJSON = JSON.parse( chunkText );
          var params = [];

          if ( chunkJSON[0].price_usd ) {
            var dollar = chunkJSON[0].price_usd;
            var string_dollar = dollar + '';
            var dollar_string = parseFloat(string_dollar);
            params.push( dollar_string );

            var percent = chunkJSON[0].percent_change_24h;
            var up = true;
            if ( percent < 0 ) {
              up = false;
            }
            var string_percent = percent + '';
            var percent_string = parseFloat(string_percent);
            if ( up ) {
              percent_string = 'up ' + percent_string;
            } else {
              percent_string = 'down ' + percent_string;
            }
            params.push( percent_string );

            response.output.text = replaceParams( response.output.text, params );
          }
          log( input, response );
          return res.json( response );
        } );
      } ).on( 'error', function(e) {
        console.log( 'failure!' );
        console.log( e );
      } );
    } else if (checkSentiment (response) ){

      // return discovery data
      var version_date = process.env.VERSION_DATE;
      var environment_id = process.env.ENVIRONMENT_ID;
      var collection_id = process.env.COLLECTION_ID;

      discovery.query({
          version_date: version_date,
          environment_id: environment_id,
          collection_id: collection_id,
          natural_language_query: currency,
          filter: '[publication_date>=now-1day, enriched_text.entities.relevance>=.8]',
          aggregation: '[average(enriched_text.sentiment.document.score),term(enriched_text.sentiment.document.label,count:3)]',
          count: 3
        },
        (err, data) => {
          if (err) {
            console.log("Error: ");
            console.log(err);
            return res.status(err.code || 500).json(err);
          }
          var apps = 0;
          var sentiment = 0;
          var pos = 0;
          var neg = 0;
          var neu = 0;
          if (data.results.length > 0 ) {

            var sentiment_string = '';
            var params = [];
            console.log(data.aggregations[0].value);
            if(data.aggregations[0].value > 0){
              if(data.aggregations[0].value > .3){
               sentiment_string = 'very positive';
              }
              else{
               sentiment_string = 'somewhat positive';
              }
            }else if(data.aggregations[0].value < 0){
              if(data.aggregations[0].value < -.3){
                sentiment_string = 'very negative';
              }
              else{
               sentiment_string = 'somewhat negative';
              }           
            } else{
              sentiment_string = 'neutral';
            }
            for(var i = 0; i < data.aggregations[1].count; i++) {
              if(data.aggregations[1].results[i].key === 'negative'){
                neg = data.aggregations[1].results[i].matching_results;
              }
              else if(data.aggregations[1].results[i].key === 'positive'){
                pos = data.aggregations[1].results[i].matching_results;
              }
            }

            params.push(sentiment_string);
            params.push(data.matching_results);
            params.push(pos);
            params.push(neg);

            response.output.text = replaceParams(response.output.text, params);
          } else {
            response.output.text.push("I cannot find an answer to your question.");
          }

          return res.json(response);
        }
      );
      return;
    } else if (checkArticle (response) ){

      // return discovery data
      var version_date = process.env.VERSION_DATE;
      var environment_id = process.env.ENVIRONMENT_ID;
      var collection_id = process.env.COLLECTION_ID;

      discovery.query({
          version_date: version_date,
          environment_id: environment_id,
          collection_id: collection_id,
          natural_language_query: currency,
          filter: '[publication_date>=now-1day, enriched_text.entities.relevance>=.8]',
          fields: '[title, url]',
          count: 5
        },
        (err, data) => {
          if (err) {
            console.log("Error: ");
            console.log(err);
            return res.status(err.code || 500).json(err);
          }
          var apps = 0;
          var sentiment = 0;
          var pos = 0;
          var neg = 0;
          var neu = 0;
          if (data.results.length > 0 ) {

            var params = [];
            params.push(data.results[0].title);
            params.push(data.results[0].url);
            params.push(data.results[1].title);
            params.push(data.results[1].url);
            params.push(data.results[2].title);
            params.push(data.results[2].url);            
            params.push(data.results[3].title);
            params.push(data.results[3].url);  
            params.push(data.results[4].title);
            params.push(data.results[4].url); 

            response.output.text = replaceParams(response.output.text, params);

          } else {
            response.output.text.push("I cannot find an answer to your question.");
          }

          return res.json(response);
        }
      );
      return;
    }
      else if ( response.output && response.output.text ) {
      return res.json( response );
    }
  }  
   else if ( response.output && response.output.text ) {
    return res.json( response );
  }
}

function log(input, output) {
  if ( logs ) {
    // If the logs db is set, then we want to record all input and responses
    var id = uuid.v4();
    logs.insert( {'_id': id, 'request': input, 'response': output, 'time': new Date()} );
  }
}

if ( cloudantUrl ) {
  // If logging has been enabled (as signalled by the presence of the cloudantUrl) then the
  // app developer must also specify a LOG_USER and LOG_PASS env vars.
  if ( !process.env.LOG_USER || !process.env.LOG_PASS ) {
    throw new Error( 'LOG_USER OR LOG_PASS not defined, both required to enable logging!' );
  }
  // add basic auth to the endpoints to retrieve the logs!
  var auth = basicAuth( process.env.LOG_USER, process.env.LOG_PASS );
  // If the cloudantUrl has been configured then we will want to set up a nano client
  var nano = require( 'nano' )( cloudantUrl );
  // add a new API which allows us to retrieve the logs (note this is not secure)
  nano.db.get( 'car_logs', function(err) {
    if ( err ) {
      console.error( err );
      nano.db.create( 'car_logs', function(errCreate) {
        console.error( errCreate );
        logs = nano.db.use( 'car_logs' );
      } );
    } else {
      logs = nano.db.use( 'car_logs' );
    }
  } );

  // Endpoint which allows deletion of db
  app.post( '/clearDb', auth, function(req, res) {
    nano.db.destroy( 'car_logs', function() {
      nano.db.create( 'car_logs', function() {
        logs = nano.db.use( 'car_logs' );
      } );
    } );
    return res.json( {'message': 'Clearing db'} );
  } );

  // Endpoint which allows conversation logs to be fetched
  app.get( '/chats', auth, function(req, res) {
    logs.list( {include_docs: true, 'descending': true}, function(err, body) {
      console.error( err );
      // download as CSV
      var csv = [];
      csv.push( ['Question', 'Intent', 'Confidence', 'Entity', 'Output', 'Time'] );
      body.rows.sort( function(a, b) {
        if ( a && b && a.doc && b.doc ) {
          var date1 = new Date( a.doc.time );
          var date2 = new Date( b.doc.time );
          var t1 = date1.getTime();
          var t2 = date2.getTime();
          var aGreaterThanB = t1 > t2;
          var equal = t1 === t2;
          if ( aGreaterThanB ) {
            return 1;
          }
          return equal ? 0 : -1;
        }
      } );
      body.rows.forEach( function(row) {
        var question = '';
        var intent = '';
        var confidence = 0;
        var time = '';
        var entity = '';
        var outputText = '';
        if ( row.doc ) {
          var doc = row.doc;
          if ( doc.request && doc.request.input ) {
            question = doc.request.input.text;
          }
          if ( doc.response ) {
            intent = '<no intent>';
            if ( doc.response.intents && doc.response.intents.length > 0 ) {
              intent = doc.response.intents[0].intent;
              confidence = doc.response.intents[0].confidence;
            }
            entity = '<no entity>';
            if ( doc.response.entities && doc.response.entities.length > 0 ) {
              entity = doc.response.entities[0].entity + ' : ' + doc.response.entities[0].value;
            }
            outputText = '<no dialog>';
            if ( doc.response.output && doc.response.output.text ) {
              outputText = doc.response.output.text.join( ' ' );
            }
          }
          time = new Date( doc.time ).toLocaleString();
        }
        csv.push( [question, intent, confidence, entity, outputText, time] );
      } );
      res.csv( csv );
    } );
  } );
}

function checkCurrency(data) {
  //return data.intents && data.intents.length > 0 && data.intents[0].intent === 'weather'
    return data.context && data.context.currency != null;
}

function checkPrice(data) {
  return data.intents && data.intents.length > 0 && data.intents[0].intent === 'price';
}

function checkSentiment(data) {
  return data.intents && data.intents.length > 0 && data.intents[0].intent === 'sentiment';
}

function checkArticle(data) {
  return data.intents && data.intents.length > 0 && data.intents[0].intent === 'view_articles';
}

function replaceParams(original, args) {
  if ( original && args ) {
    var text = original.join( ' ' ).replace( /{(\d+)}/g, function(match, number) {
      return typeof args[number] !== 'undefined'
        ? args[number]
        : match
        ;
    } );
    return [text];
  }
  return original;
}

function getPriceURL(coin) {
  if ( coin !== null ) {
    return 'https://api.coinmarketcap.com/v1/ticker/' + coin + '/?convert=USD';
  }
}

module.exports = app;
