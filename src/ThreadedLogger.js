"use strict";

var _ = require('underscore');
var Common = require('./common.js');

var logLevel = ["debug", "info", "warn", "error"];
var lastLog = 0;

var TreadedLogger = function (moduleLogger) {
    lastLog++;

    (function(obj) {
        var extra_meta = {
            logid: 'logid_'+lastLog,
            user: ""
        };
        obj.logger = (moduleLogger ? moduleLogger : Common.logger);
        obj.startTime = new Date();
        obj.prevTime = obj.startTime;
        logLevel.forEach(function(level) {
            TreadedLogger.prototype[level] = function() {
                var len = arguments.length, arr = new Array(len+2);
                arr[0] = level;
                for (var i = 0; i < (len); i += 1) {
                    arr[i+1] = arguments[i];
                }
                if(typeof arr[len] === 'object' && Object.prototype.toString.call(arr[len-1]) !== '[object RegExp]') {
                    arr[len] = _.extend({}, arr[len], extra_meta);
                    arr[len+1] = null;
                } else {
                    arr[len+1] = extra_meta;
                }
                obj.logger.log.apply(Common.logger, arr);
            };
        });
        obj.logTime = function(text) {
            var curTime = new Date();
            var startDiff = curTime - obj.startTime;
                var prevLogDiff = curTime - obj.prevTime;
            obj.info("TimeLog. s: "+startDiff+" ms, p: "+prevLogDiff+" ms, text: "+text);
            obj.prevTime = curTime;
        };
        obj.user = function(user) {
            extra_meta.user = user;
        };
        obj.log = function(text,meta) {
            obj.logger.log(text,meta);
        };
            return obj;
    })(this);
};

if (module) {
    module.exports = TreadedLogger;
}

