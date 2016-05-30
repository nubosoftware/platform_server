"use strict";

var http = require('http');
var https = require('https');

module.exports = {
    doPostRequest: doPostRequest,
    doGetRequest: doGetRequest,
    getDataFromRequest: getDataFromRequest,
    getObjFromRequest: getObjFromRequest
};

function doPostRequest(options, postData, callback) {
    var callbackDone = false;
    var resData = "";
    var request;
    if(options.key) request = https.request;
    else request = http.request;
    var req = request(
        options,
        function(res) {
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                resData = resData + chunk;
            });
            res.on('end', function() {
                if(!callbackDone) {
                    callbackDone = true;
                    callback(null, resData);
                }
            });
        }
    );

    req.on('error', function(e) {
        if(!callbackDone) {
            callbackDone = true;
            callback("Error while request", e);
        }
    });

    req.write(postData);
    req.end();
}

function doGetRequest(options, callback) {
    var callbackDone = false;
    var resData = "";
    var request;
    if(options.key) request = https.request;
    else request = http.request;
    var req = request(
        options,
        function(res) {
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                resData = resData + chunk;
            });
            res.on('end', function() {
                if(!callbackDone) {
                    callbackDone = true;
                    callback(null, resData);
                }
            });
        }
    );

    req.on('error', function(e) {
        if(!callbackDone) {
            callbackDone = true;
            callback("Error while request", e);
        }
    });

    req.end();
}

function getDataFromRequest(req, callback) {
    var completeRequest = '';
    var callbackDone = false;
    req.on('data', function(chunk) {
        completeRequest += chunk;
    });

    req.on('end', function() {
        if(!callbackDone) {
            callbackDone = true;
            callback(null, completeRequest);
        }
    });
}

function getObjFromRequest(req, callback) {
    getDataFromRequest(req, function(err, rawData) {
        var msg = null;
        var reqestObj = {};
        if(err) {
            msg = err;
        } else {
            try {
                reqestObj = JSON.parse(rawData);
            } catch(e) {
                msg = "Bad post request";
                reqestObj = e;
            }
        }
        callback(msg, reqestObj);
    });
}
