"use strict";

var winston = require('winston');
var fs = require('fs');
var path = require('path');
var async = require('async');

var Common = {
    "sslCerts": {
        "ca": "../cert/root.crt",
        "key": "../cert/platform.key",
        "cert": "../cert/platformFull.crt"
    },
    managementCertsFingerprint: [],
    managementCertIssuerFingerprint: "B9:60:12:5A:15:AE:6A:5B:09:12:24:04:DC:0A:1E:E0:6B:15:93:85"
};

try {
    fs.mkdirSync("./log");
} catch(err) {
}

var loggerName = path.basename(process.argv[1], '.js') + ".log";
var exceptionLoggerName = path.basename(process.argv[1], '.js') + "_exceptions.log";
console.log("log file: " + loggerName);

require('winston-syslog').Syslog();

var logger = new (winston.Logger)({
    transports:
        [
            new (winston.transports.Console)({
                json: false,
                timestamp: true
            }),
            new winston.transports.File({
                filename: __dirname + '/log/' + loggerName,
                handleExceptions: true,
                json: false
            }),
            new winston.transports.Syslog({
                app_name: "platform_server",
                handleExceptions: true,
                json: true
            })
        ],
    exceptionHandlers:
        [
            new (winston.transports.Console)({
                json: false,
                timestamp: true
            }),
            new winston.transports.File({
                filename: __dirname + '/log/' + exceptionLoggerName,
                json: false
            })
        ],
    exitOnError: false
});
Common.logger = logger;

var firstTimeLoad = true;

function to_array(args) {
    var len = args.length, arr = new Array(len), i;

    for(i = 0; i < len; i += 1) {
        arr[i] = args[i];
    }

    return arr;
}

function parse_configs() {
    //logger.info('Load settings from file');
    var msg;
    fs.readFile('Settings.json', function(err, data) {
        if(err) {
            Common.logger.error('Error: Cannot load settings from file');
            return;
        }
        msg = data.toString().replace(/[\n|\t]/g, '');
        var settings = JSON.parse(msg);
        if(settings.logLevel && (settings.logLevel !== Common.logLevel)) logger.level = settings.logLevel;
        Common.logger.debug(settings);

        // load all attributes of settings in to Common
        for(var attrname in settings) {
            Common[attrname] = settings[attrname];
        }

        if(firstTimeLoad) {
        }

        if(Common.loadCallback)
            Common.loadCallback(null, firstTimeLoad);

        firstTimeLoad = false;
    });
}
Common.exitJobs = [];

Common.quit = function() {
    async.eachSeries(
        Common.exitJobs,
        function(err) {
            Common.logger.info("End process");
        }
    );
    process.exit(0);
};

parse_configs();

var watcher = fs.watchFile('Settings.json', {
    persistent: false,
    interval: 5007
}, function(curr, prev) {
    logger.info('Settings.json. the current mtime is: ' + curr.mtime);
    logger.info('Settings.json. the previous mtime was: ' + prev.mtime);
    parse_configs();
});

module.exports = Common;

