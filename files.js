"use strict";

var async = require('async');
var Platform = require('./platform.js');
var ThreadedLogger = require('./ThreadedLogger.js');
var http = require('./http.js');

module.exports = {
    refreshMedia: refreshMedia
};

function refreshMedia(req, res) {
    var logger = new ThreadedLogger();
    logger.logTime("Start process request refreshMedia");
    var platform = new Platform(logger);
    async.waterfall(
        [
            //get data from post request
            function(callback) {
                http.getObjFromRequest(req, function(err, obj) {
                    callback(err, obj);
                });
            },
            function(reqestObj, callback) {
                processRefreshMedia(reqestObj, logger, callback);
            },
            function(tasksResult, errFlag, callback) {
                var resobj = {
                    status: errFlag ? 0 : 1,
                    results: tasksResult
                };
                res.end(JSON.stringify(resobj, null, 2));
                callback(null);
            }
        ], function(err) {
            logger.logTime("Finish process request refreshMedia");
        }
    );
}

var processRefreshMedia = function(obj, logger, callback) {
    var unum = obj.unum;
    var paths = obj.paths;
    var platform = new Platform(logger);
    async.eachSeries(
        paths,
        function(path, callback) {
            var broadcastParams = ' -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:/storage/emulated/legacy/'+
                                    paths;
            var action = 'android.intent.action.MEDIA_SCANNER_SCAN_FILE';
            var dir = 'file:/storage/emulated/legacy/' + path;
            var cmd = 'am broadcast --user ' + unum + ' -a ' + action + ' -d ' + dir;
            platform.exec(cmd, function(err, code, signal, sshout) {
                // Ignore errors
                callback(null);
            });
        },
        function(err) {
            callback(null);
        }
    );
};
