"use strict";

var async = require('async');
var _ = require('underscore');
var validate = require("validate.js");
var exec = require('child_process').exec;
var http = require('./http.js');
var ThreadedLogger = require('./ThreadedLogger.js');

function post(req, res, next) {
    var logger = new ThreadedLogger();
    var reqestObj;
    async.waterfall(
        [
            //get data from post request
            function(callback) {
                http.getObjFromRequest(req, function(err, obj) {
                    callback(err, obj);
                });
            },
            function (reqestObj, callback) {
                validateApplyFirewallRequestObj(reqestObj, logger, callback);
            },
            function(obj, callback) {
                logger.info("applyFirewall input: " + JSON.stringify(obj));
                callback(null, obj.tasks);
            },
            function(tasks, callback) {
                var tasks_ip4 = _.filter(tasks, function(item) {return item.v === "v4";});
                var tasks_ip6 = []; //_.filter(tasks, function(item) {return item.v === "v6"});
                //logger.info("ip4 tasks: " + JSON.stringify(tasks_ip4));
                callback(null, tasks_ip4, tasks_ip6);
            },
            function(tasks_ip4, tasks_ip6, callback) {
                var err4 = "", err6 = "";
                var restore4 = convertTasksToRestoreBlock(tasks_ip4, err4);
                var restore6 = convertTasksToRestoreBlock(tasks_ip6, err6);
                if(!restore4 && err4) logger.error("Cannot build input for iptable, err: " + err4 + "\ntasks: " + JSON.stringify(tasks_ip4)); 
                if(!restore6 && err6) logger.error("Cannot build input for iptable, err: " + err6 + "\ntasks: " + JSON.stringify(tasks_ip6)); 
                //logger.info("ip4 restore: " + restore4);
                callback(null, restore4, restore6);
            },
            //function(restore4, restore6, callback) {
            //    logger.info("apply iptables6");
            //    applyIptables("v6", restore6, function(err) {
            //        callback(null, restore4, restore6);
            //    });
            //},
            function(restore4, restore6, callback) {
                logger.info("apply iptables");
                applyIptables("v4", restore4, function(err) {
                    callback(err);
                });
            }
        ], function(err) {
            logger.logTime("Finish process request applyFirewall");
            var resobj;
            if(err) {
                resobj = {
                    status: 0,
                    error: err
                };
            } else {
                resobj = {
                    status: 1
                };
            }
            res.send(resobj);
        }
    );
}

var convertTasksToRestoreBlock = function(tasks, err) {
    if(tasks.length === 0) return "";

    var restore = "*filter\n";
    tasks.forEach(function(task) {
        var line = convertTaskObjToRestoreLine(task, err);
        if(line) {
            restore += line + "\n";
        }
    });
    restore += "COMMIT\n";
    return restore;
};


var convertTaskObjToRestoreLine = function(obj, err) {
    var Commands = {
        "append": "-A",
        "check": "-C",
        "delete": "-D",
        "insert": "-I",
        "replace": "-R",
        "list": "-L",
        "list-rules": "-S",
        "flush": "-F",
        "zero": "-Z",
        "new": "-N",
        "delete-chain": "-X",
        "policy": "-P",
        "rename-chain": "-E"
    };
    var res = "";
    var block = "";

    if(obj.cmd) {
        if(Commands[obj.cmd]) {
            res = Commands[obj.cmd];
        } else {
            err +=("Bad command in task: " + JSON.stringify(obj));
            return "";
        }
    } else {
        err +=("No command in task: " + JSON.stringify(obj));
        return "";
    }

    if(obj.chain) {
        res += " " + obj.chain;
    } else {
        err +=("No chain in task: " + JSON.stringify(obj));
        return "";
    }

    if(obj.source) {
        if(obj.source.ip) {
            res += " -s " + obj.source.ip;
        }
        if(obj.source.port) {
            res += " --sport " + obj.source.port;
        }
    }

    if(obj.destination) {
        if(obj.destination.ip) {
            res += " -d " + obj.destination.ip;
        }
        if(obj.destination.port) {
            res += " --dport " + obj.destination.port;
        }
    }

    if(obj.protocol) {
        if(obj.protocol) {
            res += " -p " + obj.protocol;
        }
    }

    if(obj.match) {
        if(obj.match) {
            res += " -m " + obj.match;
        }
    }

    if(obj.job) {
        if(obj.job) {
            res += " -j " + obj.job;
        }
    }

    return res;
};

var applyIptables = function(version, input, callback) {
    var logger = new ThreadedLogger();
    logger.info("Version " + version + " input:\n" + input);
    var Commands = {
        "v4": "iptables-restore",
        "v6": "iptables6-restore"
    };
    if(input) {
        var cmd = Commands[version];
        if(cmd) {
            var proc = require("child_process").spawn(cmd, ["-n"]);
            var output = "";
            
            proc.stdin.write(input);
            proc.stdin.end();

            proc.stdout.on("data", function(data) {
                output += output;
            });

            proc.stderr.on("data", function(data) {
                output += output;
            });

            proc.on("close", function(code) {
                if(code === 0) {
                    callback(null);
                } else {
                    callback("exit code " + code + " output:" + output);
                }
            });
        } else {
            callback("bad version");
        }
    } else {
        callback(null);
    }
};

var validateApplyFirewallRequestObj = function(RequestObj, logger, callback) {
    logger.warn("validateApplyFirewallRequestObj not implemented");
    callback(null, RequestObj);
};

module.exports = {post: post};

