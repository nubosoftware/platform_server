"use strict";

var async = require('async');
var fs = require('fs');
var validate = require("validate.js");
var Platform = require('./platform.js');
const machineModule = require('./machine.js');
var ThreadedLogger = require('./ThreadedLogger.js');
var http = require('./http.js');
var Common = require('./common.js');
const path = require('path');
const { logger } = require('./common.js');
const { execDockerCmd , ExecCmdError, execDockerWaitAndroid } = require('./dockerUtils');
const user = require('./user');
const fsp = fs.promises;
const Lock = require('./lock');

module.exports = {
    installApk: installApk,
    attachApps: attachApps,
    getPackagesList: getPackagesList,
    updateAppRestrictions
};

var INSTALL_TASK = [1, "i", "install"];
var UNINSTALL_TASK = [0, "u", "uninstall"];
var UPGRADE_TASK = [2, "g", "upgrade"];

function installApk(req, res,next) {
    var logger = new ThreadedLogger(Common.getLogger(__filename));
    var apk = req.params.apk;
    if (machineModule.isDockerPlatform()) {
        let docker_image = req.params.docker_image;
        refreshImageDocker(apk,docker_image,logger).then((result) => {
            //logger.info("Apk " + apk + " installed");
            resobj = {
                status: 1,
                msg: "OK"
            };
            res.end(JSON.stringify(resobj, null, 2));
        }).catch(err => {
            logger.error(`APK install error: ${err}`,err);
            resobj = {
                status: 0,
                msg: `Error: ${err}`
            };
            res.end(JSON.stringify(resobj, null, 2));
        });
        return;
    }
    // Test for path manipulation
    if ((apk.indexOf('..') >= 0) || (apk.indexOf('/data/tmp/') !== 0)) {
        var resobj = {
            status: 0,
            msg: 'Invalid file name'
        };
        res.end(JSON.stringify(resobj, null, 2));
        logger.error("Fail process request installApk");
        return;
    }
    logger.logTime("Start process request installApk");

    tryInstallApk(apk, 1, 0, logger, function(err, msg) {
        var resobj;
        if (err) {
            logger.error("Cannot install apk " + apk + "\nOutput:\n" + msg);
            resobj = {
                status: 0,
                msg: msg
            };
        } else {
            logger.info("Apk " + apk + " installed");
            resobj = {
                status: 1,
                msg: "OK"
            };

        }
        res.end(JSON.stringify(resobj, null, 2));
        logger.logTime("Finish process request installApk");
    });
}

var tryInstallApk = function(apkPath, retries, wait, logger, callback) {
    var msg = "";
    var platform = new Platform(logger);
    logger.info("Try install apk " + apkPath);
    var retryInstallApk = function(path, retries, wait, logger, callback) {
        if (retries < 1) {
            callback("Cannot install apk", msg);
        } else {
            platform.execFile("pm", ["install", "--user", "0", "-r", apkPath], function(err, stdout, stderr) {
                if (err) {
                    if (stderr.indexOf("Failure [INSTALL_FAILED_VERSION_DOWNGRADE]") === -1) {
                        msg += apkPath + ":\n" + stderr;
                        setTimeout(function() {
                            retryInstallApk(apkPath, retries - 1, wait, logger, callback);
                        }, wait);
                    } else {
                        callback(null);
                    }
                } else {
                    //disableUserZero(apkPath,platform,logger);
                    callback(null);
                }
            });
        }
    };
    retryInstallApk(apkPath, retries, wait, logger, callback);
};



var disableUserZero = function(apkPath,platform,logger, callback) {
    let packagename = path.basename(apkPath, '.apk');
    platform.execFile("pm", ["disable", "--user", "0", packagename], function(err, stdout, stderr) {
        if (err) {
            logger.info(`disableUserZero. packagename: ${packagename}, err: ${err}, stdout: ${stdout}, stderr: ${stderr}`);
        }
        if (callback) {
            callback(null);
        }
    });
}

/*
 * Send data:
 *  {data: [{packageName, unum, task}, ...]
 *   task: 1,"i", "install" for installation; 0, "u", "uninstall" for uninstallation
 */
function attachApps(req, res,next) {
    var logger = new ThreadedLogger(Common.getLogger(__filename));
    logger.logTime("Start process request attachApps");
    var obj = req.body;

    async.waterfall(
        [
            //create workable android user
            function(callback) {
                if (obj.tasks.length > 0) {
                    processTasks(obj.tasks, logger, callback);
                } else {
                    callback(null, [], true);
                }
            },
            function(tasksResult, errFlag, callback) {
                var resobj = {
                    status: errFlag ? 0 : 1,
                    results: tasksResult
                };
                res.end(JSON.stringify(resobj, null, 2));
                callback(null);
            }
        ],
        function(err) {
            logger.logTime("Finish process request attachApps");
        }
    );
}


async function updateAppRestrictions(req, res) {
    var logger = new ThreadedLogger(Common.getLogger(__filename));
    logger.logTime("Start process request updateAppRestrictions");
    try {
        const userModule = require('./user');
        let unum = req.params.unum;
        let session = await userModule.loadUserSessionPromise(unum,logger);
        const containerId = session.params.containerId;
        let packageNames = await userModule.copyUpdatFilesToSession(session);
        for (const packageName of packageNames) {
            logger.info(`updateAppRestrictions. updateAppRestrictions. packageName: ${packageName}`);
            let execRes = await execDockerWaitAndroid(
                ['exec' , containerId, 'pm', 'updateAppRestrictions' , '10',packageName]
            );
        }
        var resobj = {
            status: 1,
            error: "Updated"
        };
        res.end(JSON.stringify(resobj,null,2));
    } catch (err) {
        logger.error("updateAppRestrictions error: " + err,err);
        var resobj = {
            status: 0,
            error: `${err}`
        };
        res.end(JSON.stringify(resobj,null,2));

    }
    logger.logTime("Finish process request updateAppRestrictions");

};


var installAppInBackgrond = function(containerId,installTarget) {

    execDockerCmd(
        ['exec' , containerId, '/usr/bin/apt', 'install' , '-y' , installTarget]
    ).then(obj => {
        const { stdout, stderr } = obj;
        logger.info(`Installed package ${installTarget} on container ${containerId}.\nstdout: ${stdout}\nstderr: ${stderr}`);
    }).catch(e => {
        const {err,stdout,stderr} = e;
        logger.info(`Error installing package ${installTarget} on container ${containerId}.\nError: ${e}\nstdout: ${stdout}\nstderr: ${stderr}`);
    });

}

/**
 * Install APK on all session containers that use the docker_image
 * @param {*} apk
 * @param {*} docker_image
 * @param {*} logger
 */
 var refreshImageDocker = async function(apk,docker_image,logger) {
    logger.info(`refreshImageDocker. docker_image: ${docker_image}`);
    await require('./user').refreshImagePool(docker_image);


    // let sessions = machineConf.sessions;
    // if (sessions) {
    //     for (const sessKey in sessions) {
    //         const unum = sessions[sessKey].localid;
    //         let sess = await require('./user').loadUserSessionPromise(unum,logger);
    //         if (sess && sess.params.docker_image == docker_image) {
    //             sessionsToUpdate.push(sess);
    //         }
    //     }
    // }
    // for (const session of sessionsToUpdate) {
    //     const containerId = session.params.containerId;
    //     const unum = session.params.localid;
    //     let apkPath = path.resolve("./apks",apk);
    //     let sessApkPath = "/nubo/apks/";
    //     logger.info(`Copy apk from ${apkPath} to ${sessApkPath}`);
    //     let cpres = await execDockerWaitAndroid(['cp',apkPath,`${containerId}:${sessApkPath}`]);



    //     let installTarget = path.resolve(sessApkPath,apk);
    //     try {
    //         //create temp_app dir if needed so app will not be installed in image
    //         let tempAppDir = path.resolve(session.params.sessPath,"temp_app");
    //         let exists = await fileExists(tempAppDir);
    //         if (!exists) {
    //             await fsp.mkdir(tempAppDir,{recursive: true});
    //             await fsp.chown(tempAppDir,1000,1000);
    //             await fsp.chmod(tempAppDir,'777');
    //             await execDockerWaitAndroid(
    //                 ['exec' , containerId, 'mount', '--bind', '/nubo/temp_app', '/data/app' ]
    //             );
    //         }

    //         logger.info(`Installing apk ${apk} on container ${unum}..`);
    //         const { stdout, stderr } = await execDockerWaitAndroid(
    //             ['exec' , containerId, 'pm', 'install' , '--user','0', '-r', installTarget]
    //         );
    //     } catch (err) {
    //         logger.info(`Install apk error on constainer ${unum}: ${err}, stdout: ${err.stdout}, stderr: ${err.stderr}`);
    //     }
    // }

}

async function fileExists(filepath) {
    try {
        await fsp.access(filepath);
        return true;
    } catch (e) {
        return false;
    }
}

var processTasksDocker = async function(tasks, logger) {
    let errFlag = false;
    let results = [];
    for (const task of tasks) {
        try {
            logger.info(`processTasksDocker task: ${JSON.stringify(task,null,2)}`);
            // load the user session
            let session = await require('./user').loadUserSessionPromise(task.unum,logger);
            const containerId = session.params.containerId;
            if (session.login.deviceType != "Desktop" && !session.params.readyToInstall) {
                await require('./user').waitForPlatformStartPhase(session,"SYNC_MANAGER_UNLOCKED user #10",logger);
                const lockSess = new Lock(`sess_${task.unum}`, {
                    lockTimeout: Common.sessionLockTimeout || (2 * 60 * 1000)
                });
                try {
                    await lockSess.acquire();
                    session = await require('./user').loadUserSessionPromise(task.unum,logger);
                    session.params.readyToInstall = true;
                    await require('./user').saveUserSessionPromise(task.unum,session);
                } finally {
                    lockSess.release();
                }
            }

            if (INSTALL_TASK.indexOf(task.task) !== -1) {
                if (session.login.deviceType == "Desktop") {
                    let installTarget = task.packageName;
                    if (task.filename) {
                        // we will need to copy the file into the container
                        let debPath = path.resolve("./debs",task.filename);
                        installTarget = `/root/${task.filename}`;

                        await execDockerCmd(
                            ['cp' , debPath, `${containerId}:${installTarget}`]
                        );
                    }

                    // run the install command
                    logger.info(`Installing in background. package: ${installTarget}, container: ${containerId}`);
                    installAppInBackgrond(containerId,installTarget);
                    task.status = 1;
                } else {
                    // instal in mobile
                    // if (!task.filename) {
                    //     task.filename = `${task.packageName}.apk`;
                    // }
                    // let apkPath = path.resolve("./apks",task.filename);
                    // let sessApkPath = "/nubo/apks/";
                    // logger.info(`Copy apk from ${apkPath} to ${sessApkPath}`);

                    // let cpres = await execDockerWaitAndroid(['cp',apkPath,`${containerId}:${sessApkPath}`]);


                    // let installTarget = path.resolve(sessApkPath,task.filename);
                    // const { stdout, stderr } = await execDockerWaitAndroid(
                    //     ['exec' , containerId, 'pm', 'install' , '--user','0', '-r', installTarget]
                    // );

                    // enable package
                    const { stdout, stderr } = await execDockerWaitAndroid(
                        ['exec' , containerId, 'pm', 'enable' , '--user','10', task.packageName]
                    );
                    logger.info(`Installed package ${task.packageName} on container ${containerId}.\nstdout: ${stdout}\nstderr: ${stderr}`);
                    task.status = 1;
                }
            } else if (UNINSTALL_TASK.indexOf(task.task) !== -1) {
                // run the uninstall command
                if (session.login.deviceType == "Desktop") {
                    const { stdout, stderr } = await execDockerCmd(
                        ['exec' , containerId, '/usr/bin/apt', 'purge' , '-y', task.packageName]
                    );
                    logger.info(`Uninstalled package ${task.packageName} on container ${containerId}.\nstdout: ${stdout}\nstderr: ${stderr}`);
                    task.status = 1;
                } else {
                    let execRes;
                    try {
                        // execRes = await execDockerWaitAndroid(
                        //     ['exec' , containerId, 'pm', 'uninstall' , '--user','0',task.packageName]
                        // );
                        execRes = await execDockerWaitAndroid(
                            ['exec' , containerId, 'pm', 'disable' , '--user','10',task.packageName]
                        );
                    } catch (err) {
                        if (err instanceof ExecCmdError) {
                            if (err.stdout.indexOf("not installed for 0") >= 0) {
                                //ignore error if packge is not install
                                execRes = err;
                            } else {
                                throw err;
                            }
                        } else {
                            throw err;
                        }
                    }
                    logger.info(`Uninstalled package ${task.packageName} on container ${containerId}.\nstdout: ${execRes.stdout}\nstderr: ${execRes.stderr}`);
                    task.status = 1;
                }
            } else if (UPGRADE_TASK.indexOf(task.task) !== -1) {
                // upgrade task
                if (session.login.deviceType == "Desktop") {
                    // TBD support upgrade in desktop
                } else {
                    // mobile upgrade
                    // check if package installed
                    const listRet = await execDockerWaitAndroid(
                        ['exec' , containerId, 'pm', 'list' , 'packages','--user','0', task.packageName]
                    );
                    // if (listRet.stdout && listRet.stdout.indexOf(task.packageName) >= 0) {
                    //     logger.info(`Upgrading packge: ${task.packageName}`);
                    //     let apkPath = path.resolve("./apks",task.filename);
                    //     let sessApkPath = "/nubo/apks/";
                    //     logger.info(`Copy apk from ${apkPath} to ${sessApkPath}`);
                    //     // await fsp.copyFile(apkPath,sessApkPath);
                    //     let cpres = await execDockerWaitAndroid(['cp',apkPath,`${containerId}:${sessApkPath}`]);

                    //     // let installTarget = path.resolve("/system/vendor/apks",task.filename);
                    //     let installTarget = path.resolve(sessApkPath,task.filename);
                    //     const { stdout, stderr } = await execDockerWaitAndroid(
                    //         ['exec' , containerId, 'pm', 'install' , '--user','0', '-r', installTarget]
                    //     );
                    //     logger.info(`Upgraded package ${task.packageName} on container ${containerId}.\nstdout: ${stdout}\nstderr: ${stderr}`);
                    // } else {
                        logger.info(`Upgrade. packge: ${task.packageName} is not installed in user: ${listRet.stdout}`);
                    // }
                    task.status = 1;
                }
            } else {
                task.status = 0;
                task.statusMsg = "Bad task";
                errFlag = true;
            }
        } catch (err) {
            logger.error(`processTasksDocker. Error execute task: ${err}`,err);
            if (err instanceof ExecCmdError) {
                logger.info(`processTasksDocker. stdout: ${err.stdout}\n stderr: ${err.stderr}`);
                if (err.stdout && err.stdout.indexOf("INSTALL_FAILED_INSUFFICIENT_STORAGE") >= 0) {
                    err = "INSTALL_FAILED_INSUFFICIENT_STORAGE";
                } else if (err.stderr && err.stderr.indexOf("but not enough space") >= 0) {
                    err = "INSTALL_FAILED_INSUFFICIENT_STORAGE";
                }
            }
            task.status = 0;
            task.statusMsg = `${err}`;
            errFlag = true;
        }
        results.push(task);
    }
    return({
        errFlag,
        results
    });
}


var processTasks = function(tasks, logger, callback) {
    if (machineModule.isDockerPlatform()) {
        processTasksDocker(tasks,logger).then((result) => {
            const {results, errFlag } = result;
            callback(null, results, errFlag);
        }).catch(err => {
            callback(null, [], true);
        });
        return;
    }
    var platform = new Platform(logger);
    var results = [];
    var errFlag = false;
    async.eachSeries(
        tasks,
        function(task, callback) {
            var cmd;
            logger.info(`processTasks task: ${JSON.stringify(task,null,2)}`);
            if (INSTALL_TASK.indexOf(task.task) !== -1) {
                platform.execFile("pm", ["install", "--user", task.unum, task.packageName], function(err, stdout, stderr) {
                    if (err) {
                        task.status = 0;
                        task.statusMsg = stderr;
                        errFlag = true;
                    } else {
                        task.status = 1;
                    }
                    results.push(task);
                    callback(null);
                });
            } else if (UNINSTALL_TASK.indexOf(task.task) !== -1) {
                cmd = 'pm uninstall --user ' + task.unum + ' ' + task.packageName;
                platform.execFile("pm", ["uninstall", "--user", task.unum, task.packageName], function(err, stdout, stderr) {
                    if (err) {
                        task.status = 0;
                        task.statusMsg = stderr;
                        errFlag = true;
                    } else {
                        task.status = 1;
                    }
                    results.push(task);
                    callback(null);
                });
            } else {
                task.status = 0;
                task.statusMsg = "Bad task";
                errFlag = true;
                results.push(task);
                callback(null);
            }
        },
        function(err) {
            logger.info("processTasks results: ", results);
            callback(null, results, errFlag);
        }
    );
};

async function getPackagesListDocker(req,res,logger) {
    try {
        let imageName = req.params.imageName;
        logger.info(`getPackagesListDocker. imageName: ${imageName}`);
        let session = await require('./user').createPooledSession(imageName,true);
        if (!session) {
            throw new Error(`Cannot create pooled session for package list`);
        }
        try {
            logger.info(`getPackagesListDocker. session created..`);
            const systemPath = path.join(session.params.sessPath,"system");
            const packagesXml = await fsp.readFile(path.join(systemPath,"packages.xml"),"utf8");
            const packagesList = await fsp.readFile(path.join(systemPath,"packages.list"),"utf8");
            const nuboPlatformVersion = await fsp.readFile(path.join(systemPath,"nubo_platform.version"),"utf8");
            res.end(JSON.stringify({
                status: 1,
                data: {
                    "packages.xml" : packagesXml,
                    "packages.list" : packagesList,
                    "nubo_platform.version": nuboPlatformVersion
                }
            }));
        } finally {
            await require('./user').detachUserDocker(session.params.localid);
        }

    } catch (err) {
        logger.error(`getPackagesListDocker error: ${err}`,err);
        var resobj = {
            status: 0,
            msg: `${err}`
        };
        res.end(JSON.stringify(resobj, null, 2));
    }
}

function getPackagesList(req, res,next) {
    var logger = new ThreadedLogger(Common.getLogger(__filename));
    if (machineModule.isDockerPlatform()) {
        getPackagesListDocker(req,res,logger).then(() => {
            logger.logTime(`getPackagesListDocker finished`);
        }).catch(err => {
            logger.info(`Error in getPackagesList: ${err}`);
        });
        return;
    }
    var filter = req.params.filter;

    logger.logTime("Start process request getPackagesList");
    var platform = new Platform(logger);
    var data;
    async.waterfall(
        [
            //get data from packages.list
            function(callback) {
                fs.readFile("/Android/data/system/packages.list", function(err, data) {
                    if (err) {
                        callback(err);
                    } else {
                        callback(null, data.toString());
                    }
                });
            },
            //parse data
            function(rawdata, callback) {
                var packagesObjArray = [];
                var lines = rawdata.split("\n");
                lines.forEach(function(line) {
                    if (line !== "") {
                        var fields = line.split(" ");
                        var packagesObj = {
                            packageName: fields[0],
                            offset: fields[1]
                        };
                        if (!filter || (filter && filter === packagesObj.packageName)) {
                            packagesObjArray.push(packagesObj);
                        }
                    }
                });
                callback(null, packagesObjArray);
            },
        ],
        function(err, data) {
            var resobj = {};
            if (err) {
                resobj.status = 0;
                resobj.msg = err;
            } else {
                resobj.status = 1;
                resobj.data = data;
            }
            res.end(JSON.stringify(resobj, null, 2));
            //logger.info("resobj: " + JSON.stringify(resobj, null, 2));
            //logger.logTime("Finish process request getPackagesList");
        }
    );
}

var validateAttachAppsRequestObj = function(reqestObj, logger, callback) {
    var validate = require("validate.js");
    var constraints = require("@nubosoftware/nubo-validateconstraints")(validate);

    var constraint = {
        tasks: {
            isArray: true,
            array: {
                packageName: constraints.packageNameConstrRequested,
                unum: constraints.IndexConstrRequested,
                task: {
                    presence: true,
                    inclusion: {
                        within: [0, 1]
                    }
                }
            }
        }
    };
    var res = validate(reqestObj, constraint);
    if (res) logger.error("input is not valid: " + JSON.stringify(res));
    callback(res, reqestObj);
};
