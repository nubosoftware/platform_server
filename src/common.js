"use strict";

var fs = require('fs');
var path = require('path');
var async = require('async');
var _ = require('underscore');
var fsp = require('fs').promises;

var Common = {
    "sslCerts": {
        "ca": "../cert/root.crt",
        "key": "../cert/platform.key",
        "cert": "../cert/platformFull.crt"
    },
    managementPublicKey: "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzvlbq4mQcmE4DbdlGE3c\nniWijiYG6IX1MJ8dyFzAdsxkj94rap59BLFc6lnQsxcuqvtOGxt18bNQUnUDdrwb\nJbn/Out4LE7QhFm29eYHxcS1BVArPGB+KwDUEACL1DRHvsVkBVSXynH/Y5v4Mb2W\n9Ot5TZnMns2IZBlNredCEagnyqPboiOTjSvRZXORVHg+nITydksgTEz+Wo57wX9Z\n/HKzLKcOZ7amRe28l+NslwgUQM2VH8oh+C4h15K/jVseFEeCDq8JBVf/LxXh1wq0\nvwj1lbcHiM94wnuVfjK0Vp3nUsAScQrdEdKNiZwhxsJbqhKibKtVIaO34sNSHL/i\nTQIDAQAB\n-----END PUBLIC KEY-----",
    managementCertsFingerprint: [],
    managementCertIssuerFingerprint: "B9:60:12:5A:15:AE:6A:5B:09:12:24:04:DC:0A:1E:E0:6B:15:93:85",
    setMgmtHostName: false,
    rootDir: process.cwd(),
};

try {
    fs.mkdirSync("./log");
} catch(err) {
}

const scriptName = (process.argv[1] ? process.argv[1] : "script");
var loggerName = path.basename(scriptName, '.js') + ".log";
var exceptionLoggerName = path.basename(scriptName, '.js') + "_exceptions.log";
console.log("log file: " + loggerName);

const { createLogger , format, transports  } = require('winston');
const { combine, timestamp, label, printf } = format;
require('winston-syslog').Syslog;

const myFormat = printf(info => {
    return `${info.timestamp} [${info.label}] ${info.level}: ${info.message}`;
});

Common.intLogger = createLogger({
    format: combine(
        //label({ label:  path.basename(scriptName, '.js') }),
        timestamp(),
        myFormat
    ),
    transports : [
        new (transports.Console)({
            name: 'console',
            json : false,
            handleExceptions : true,
            timestamp: true,
            colorize: true
        }),
        new transports.File({
            name: 'file',
            filename : Common.rootDir + '/log/' + loggerName,
            handleExceptions : true,
            maxsize: 100*1024*1024, //100MB
            maxFiles: 4,
        }),
        new transports.Syslog({
            app_name : "platform_server",
            handleExceptions : true,
            localhost: null,
            protocol: "unix",
            path: "/dev/log",
            format: format.json()
        })
    ],
    exceptionHandlers : [
        new (transports.Console)({
            json : false,
            timestamp : true
        }),
        new transports.File({
            filename : Common.rootDir + '/log/' + exceptionLoggerName,
            json : false
        })
    ],
    exitOnError : false
});

let cacheLoggers = {};
Common.getLogger = (fileName) => {
    let name = path.basename(scriptName, '.js') + ( fileName ? "_"+path.basename(fileName) : "");
    if (cacheLoggers[name]) {
        return cacheLoggers[name];
    }
    let moduleLogger = {
        error: (text, err) => {
            let msg = text;
            if (err) {
                if (err.stack) {
                    msg += " " + err.stack;
                } else {
                    msg += " " + err;
                }
            }
            Common.intLogger.log({
                level: 'error',
                message: msg,
                label: name
            });
        },
        info: (text) => {
            Common.intLogger.log({
                level: 'info',
                message: text,
                label: name
            });
        },
        warn: (text) => {
            Common.intLogger.log({
                level: 'warn',
                message: text,
                label: name
            });
        },
        debug: (text) => {
            Common.intLogger.log({
                level: 'debug',
                message: text,
                label: name
            });
        },
        log: (...args) => {
            let extra_meta = {label: name};
            let len = args.length;
            if(typeof args[len-1] === 'object' && Object.prototype.toString.call(args[len-2]) !== '[object RegExp]') {
                _.extend(args[len-1], extra_meta);
            } else {
                args.push(extra_meta);
            }
            Common.intLogger.log.apply(Common.intLogger,args);
        }
    };
    cacheLoggers[name] = moduleLogger;
    return moduleLogger;
};

Common.logger = Common.getLogger("");

var logger = Common.getLogger(__filename);


var firstTimeLoad = true;

function to_array(args) {
    var len = args.length, arr = new Array(len), i;

    for(i = 0; i < len; i += 1) {
        arr[i] = args[i];
    }

    return arr;
}

async function fileExists(filepath) {
    try {
        await fsp.access(filepath);
        return true;
    } catch (e) {
        return false;
    }
}

async function fileMoveIfNedded(newFilePath,oldFilePath) {
    let exists = await fileExists(newFilePath);
    if (exists) {
        return;
    }
    let oldExists = await fileExists(oldFilePath);
    if (oldExists) {
        console.log(`Moving file ${oldFilePath} to new location at: ${newFilePath}`);
        let dir = path.dirname(newFilePath);
        await fsp.mkdir(dir,{recursive: true});
        await fsp.copyFile(oldFilePath,newFilePath);
        await fsp.unlink(oldFilePath);
        return;
    } else {
        throw new Error(`File not found in both old location: ${oldFilePath} and new location: ${newFilePath}`);
    }
}



const DOCKERKEY = '/etc/.nubo/.docker';

async function checkDockerConf() {
    if (!Common._isDockerChecked) {
        let isDocker = await fileExists(DOCKERKEY);
        Common.isDocker = true;
        let settingsFileName;
        if (isDocker) {
            console.log("Runnig in a docker container");
            settingsFileName = path.join(Common.rootDir,'conf','Settings.json');
            // move file if needed
            const oldfileLocation = path.join(Common.rootDir,'Settings.json');
            await fileMoveIfNedded(settingsFileName,oldfileLocation);           
        } else {
            Common.isDocker = false;
            settingsFileName = path.join(Common.rootDir,'Settings.json');
        }  
        Common._isDockerChecked = true;
        Common.settingsFileName = settingsFileName;
    }
}

var watcher;

function parse_configs() {
    //logger.info('Load settings from file');
    var msg;
    checkDockerConf().then(() => {
        fs.readFile(Common.settingsFileName, function (err, data) {
            if (err) {
                Common.logger.error('Error: Cannot load settings from file');
                return;
            }
            msg = data.toString().replace(/[\n|\t]/g, '');
            var settings = JSON.parse(msg);
            if (settings.logLevel && (settings.logLevel !== Common.logLevel)) logger.level = settings.logLevel;
            Common.logger.debug(settings);

            // load all attributes of settings in to Common
            for (var attrname in settings) {
                Common[attrname] = settings[attrname];
            }

            if (firstTimeLoad) {
                watcher = fs.watchFile(Common.settingsFileName, {
                    persistent: false,
                    interval: 5007
                }, function (curr, prev) {
                    logger.info('Settings.json. the current mtime is: ' + curr.mtime);
                    logger.info('Settings.json. the previous mtime was: ' + prev.mtime);
                    parse_configs();
                });
            }

            if (Common.loadCallback)
                Common.loadCallback(null, firstTimeLoad);

            firstTimeLoad = false;
        });
    }).catch(err => {
        Common.logger.error(`Fatal error: cannot find Settings.json: ${err}`, err);
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



module.exports = Common;

