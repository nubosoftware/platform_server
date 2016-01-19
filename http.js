"use strict";

module.exports = {
    getDataFromRequest: getDataFromRequest,
    getObjFromRequest: getObjFromRequest
};

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