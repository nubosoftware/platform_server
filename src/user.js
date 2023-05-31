"use strict";

var fs = require('fs');
var execFile = require('child_process').execFile;
var async = require('async');
var validate = require("validate.js");
var _ = require('underscore');
var ps = require('ps-node');
var Common = require('./common.js');
//var logger = Common.logger;
var ThreadedLogger = require('./ThreadedLogger.js');
var mount = require('./mount.js');
var Platform = require('./platform.js');
var http = require('./http.js');
var Audio = require('./audio.js');
var ps = require('ps-node');
const machineModule = require('./machine.js');
const { docker, pullImage, execDockerCmd, ExecCmdError, execDockerWaitAndroid, sleep} = require('./dockerUtils');
const {getRules,createChain, deleteRule,insertRule } = require('./ipTables');
const fsp = fs.promises;
const path = require('path');
const moment = require('moment-timezone');
const Lock = require('./lock');
const genericPool = require("generic-pool");
const logger = Common.getLogger(__filename);


module.exports = {
    attachUser: attachUser,
    detachUser: detachUser,
    //for tests
    createUser: createUser,
    endSessionByUnum: endSessionByUnum,
    receiveSMS: receiveSMS,
    declineCall: declineCall,
    loadUserSessionPromise,
    saveUserSessionPromise,
    detachUserDocker,
    createPooledSession,
    safeDetachUserDocker,
    getOrCreatePool,
    shutdownRunningSessions,
    deleteAllPools,
    refreshImagePool,
    waitForPlatformStartPhase,
    copyUpdatFilesToSession
};

let lastCreateSessionTime = 0;
const MIN_CREATE_POOL_SESSION_WAIT_MS = 1000 * 60 * 2; // wait two minutes after create session before create pooled sessions

let pools = new Map();



function getOrCreatePool(_imageName,opts) {
    let pool = pools.get(_imageName);
    if (!pool) {
        if (!opts) {
            opts = {
                min: 1,
                max: 100,
                autostart: false,
            }
        } else {
            opts.autostart = false; //overide paramter as we start the pool
            if (!opts.max) {
                opts.max = 100;
            }
        }
        const sessionPoolFactory = {
            create: async function() {
                logger.info(`sessionPoolFactory. generate pooled session for image ${_imageName}..`);
                const session = await createPooledSession(_imageName);
                if (!session) {
                    throw new Error("Pool session create error");
                }
                logger.info(`sessionPoolFactory. created session: ${session.params.localid}`);
                return session;
            },
            destroy: async function(session) {
                if (!session.params.takenFromPool) {
                    await detachUserDocker(session.params.localid);
                }
            }
          };
        logger.info(`Creating pool for image: ${_imageName}, opts: ${JSON.stringify(opts,null,2)}`);
        pool = genericPool.createPool(sessionPoolFactory, opts);
        pools.set(_imageName,pool);
        // before starting the pool check it and start it in the background
        checkAndStartPool(pool,_imageName);
    }
    return pool;
}

async function checkAndStartPool(pool,_imageName) {
    try {
        await checkSkelFolder(_imageName);
        // start the pool
        logger.info(`Starting pool for image: ${_imageName}`);
        pool.start();
    } catch (err) {
        logger.error(`Error in checkAndStartPool.`,err);
    }
}

var runningSessions = new Map();

async function getSessionFromPool(_imageName) {
    let pool = getOrCreatePool(_imageName);
    let session = await pool.acquire();
    let unum = session.params.localid;
    session.params.takenFromPool = true;
    // remove the session from the pool (without closing it)
    // wait 15 seconds before removing from pool
    setTimeout(() => {
        logger.info(`Removing pooled session (${unum}) from pool: ${_imageName}`);
        pool.destroy(session);
    },15000);

    runningSessions.set(`u_${unum}`,session);
    return session;
}



async function refreshImagePool(_imageName) {
    let pool = pools.get(_imageName);
    if (pool) {
        logger.info(`refreshImagePool. clear pool: ${_imageName}`);
        await pool.drain();
        await pool.clear();
        pools.delete(_imageName);
        let opts = pool._config;
        logger.info(`refreshImagePool. create new pool. opts: ${JSON.stringify(opts,null,2)}`);
        getOrCreatePool(_imageName,opts);
    }
}
async function deleteAllPools() {
    logger.info(`deleteAllPools`);
    for (const [_imageName, pool] of pools) {
        logger.info(`deleteAllPools. delete pool: ${_imageName}`);
        await pool.drain();
        await pool.clear();
        pools.delete(_imageName);
    }
    logger.info(`deleteAllPools finished`);
}

async function shutdownRunningSessions() {
    logger.info(`shutdownRunningSessions`);
    for (const [key, session] of runningSessions) {
        logger.info(`shutdownRunningSessions. remove session: ${key}`);
        await detachUserDocker(session.params.localid);
    }
    logger.info(`shutdownRunningSessions finished`);
}

// async function returnSessionToPool(unum,fastDetach) {
//     let pooledSession = runningSessions.get(unum);
//     if (pooledSession) {
//         logger.info(`Found pooled session for unum ${unum}. destroy it`);
//         pooledSession.session.params.fastDetach = fastDetach;
//         await pooledSession.pool.destroy(pooledSession.session);
//         runningSessions.delete(unum);
//     } else {
//         logger.info(`Not found pooled session for unum ${unum}. try to close it anyway`);
//         if (fastDetach) {
//             await fastDetachUserDocker(unum);
//         } else {
//             await detachUserDocker(unum);
//         }
//     }
// }



async function checkSkelFolder(_imageName) {
    const skelDir = path.resolve(`./docker_run/skel`);
    // check if folder exists
    if (!await Common.fileExists(skelDir)) {
        logger.info(`checkSkelFolder. skel folder does not exists: ${skelDir}`);
        await fsp.mkdir(skelDir,{recursive: true});
        await fsp.chown(skelDir,1000,1000);
        const miscDir = path.join(skelDir,"misc");
        const ethernetDir = path.join(miscDir,"ethernet");
        await fsp.mkdir(ethernetDir,{recursive: true});
        await fsp.chown(miscDir,1000,9998);
        await fsp.chmod(miscDir,'775');
        await fsp.chown(ethernetDir,1000,1000);
        await fsp.chmod(ethernetDir,'775');
        await fsp.cp( path.resolve(`./docker_run/`,"ipconfig.txt"),path.join(ethernetDir,"ipconfig.txt"));
    }
    // check if user 10 exists
    const userDir = path.join(skelDir,"user","10");
    if (!await Common.fileExists(userDir)) {
        // we need to create a temporary session to create all user folder in skel dir
        logger.info(`checkSkelFolder. User folders do not exists in skel dir. Creating a temporary session to create all user folders!`);
        let session = await createPooledSession(_imageName,true);
        if (!session) {
            throw new Error(`Cannot create pooled session and create skel folder`);
        }
        try {
            let containerID = session.params.containerId;
            await execDockerWaitAndroid(
               ['exec' , containerID, 'pm', 'create-user', 'nubo' ]
            );
            logger.info(`checkSkelFolder. user 10 created`);
            await sleep(5000);
            await execDockerWaitAndroid(
                ['exec' , containerID, 'am', 'switch-user', '10' ]
             );
            logger.info(`checkSkelFolder. user 10 activated`);
            await sleep(5000);
            await execDockerWaitAndroid(
                ['exec' , containerID, 'am', 'switch-user', '0' ]
            );
            await execDockerWaitAndroid(
                ['exec' , containerID, 'am', 'stop-user', '10' ]
            );
            await sleep(5000);
            logger.info(`checkSkelFolder. image ready`);
            await execCmd('sync',[]);
            logger.info(`checkSkelFolder. Copy temp data dir: ${session.params.tempDataDir} back to skel dir: ${skelDir}`);
            await execCmd('cp',["-aT",session.params.tempDataDir,skelDir]);

            try {
                const systemDir = path.join(session.params.sessPath,'system');
                logger.info(`checkSkelFolder. copy packages files from ${systemDir} to ${path.join(skelDir,"system")}`);
                await fsp.cp(path.join(systemDir,"packages.xml"),path.join(skelDir,"system","packages.xml"));
                await fsp.chown(path.join(skelDir,"system","packages.xml"),1000,1000);
                await fsp.cp(path.join(systemDir,"packages.list"),path.join(skelDir,"system","packages.list"));
                await fsp.chown(path.join(skelDir,"system","packages.list"),1000,1000);
                await fsp.cp(path.join(systemDir,"nubo_platform.version"),path.join(skelDir,"system","nubo_platform.version"));
                await fsp.chown(path.join(skelDir,"system","nubo_platform.version"),1000,1000);
            } catch (err) {
                logger.info(`Unable to copy packages files to skel dir. error: ${err}`);
            }


        } finally {
            logger.info(`checkSkelFolder. close temporary session`);
            await detachUserDocker(session.params.localid);
        }
        logger.info(`checkSkelFolder. Finished creating skel dir`);
    } else {
        logger.info(`checkSkelFolder. User folders exists!`);
    }
}



/**
 * Create a new session and add it to the pool
 * @param {*} _imageName
 * @param {*} doNotAddToPull
 * @param {*} _lockMachine
 * @returns
 */
async function createPooledSession(_imageName,doNotAddToPull,_lockMachine) {
    let logger = new ThreadedLogger(Common.getLogger(__filename));
    if (!_imageName) {
        logger.info(`createPooledSession. cannot create pooled session. imageName not found!`);
        return;
    }
    let now = new Date().getTime();
    // let createSessWait = (Common.sessionPool && Common.sessionPool.waitTime != undefined ? Common.sessionPool.waitTime : MIN_CREATE_POOL_SESSION_WAIT_MS);
    // let createDiff = now - lastCreateSessionTime;
    // if (createDiff < createSessWait && !doNotAddToPull) {
    //     logger.info(`createPooledSession. too early to start pooled session after ${(createDiff/1000)} seconds.`);
    //     return;
    // }
    let multiUser = (Common.sessionPool && Common.sessionPool.multiUser != undefined ? Common.sessionPool.multiUser : false);
    let unum;
    let registryURL;
    const lockMachine = (_lockMachine ? _lockMachine : new Lock("machine"));
    await lockMachine.acquire();
    try {
        let machineConf = machineModule.getMachineConf();
        // get new unum
        unum = machineConf.unumCnt;
        if (isNaN(unum) || unum == 0) {
            unum = 10;
        }
        machineConf.unumCnt = unum + 1;
        registryURL = machineConf.registryURL;
        await machineModule.saveMachineConf(machineConf);
    } finally {
        lockMachine.release();
    }

    let session = {
        params: {
            localid: unum
        },
        login: {
            deviceType: "pool"
        }
    };

    const lockSess = new Lock(`sess_${unum}`);
    try {
        await lockSess.acquire();
        let sessPath = path.resolve(`./sessions/sess_${unum}`);
        let externalSessPath;
        if (Common.externalPath) {
            externalSessPath = path.join(Common.externalPath,'sessions',`sess_${unum}`);
        } else {
            externalSessPath = sessPath;
        }
        let apksPath = path.join(sessPath,'apks');
        await fsp.mkdir(apksPath,{recursive: true});
        await fsp.chown(sessPath,1000,1000);
        let platformStartFile = path.join(sessPath,'platformStart.log');
        await fsp.appendFile(platformStartFile, `${moment().utc().format('YYYY-MM-DD HH:mm:ss')} Creating pooled session\n`, 'utf-8');
        await fsp.chown(platformStartFile,1000,1000);
        await fsp.chmod(platformStartFile,'660');

        if (!multiUser) {
            let sessionPendingFile = path.join(sessPath,'session_pending');
            await fsp.appendFile(sessionPendingFile, `${moment().utc().format('YYYY-MM-DD HH:mm:ss')} Creating session pending\n`, 'utf-8');
            await fsp.chown(platformStartFile,1000,1000);
            await fsp.chmod(platformStartFile,'660');
            session.params.sessionPendingFile = sessionPendingFile;
        }

        let tempDataDir = path.join(sessPath,'temp_data_dir');
        let externalTempDataDir =  path.join(externalSessPath,'temp_data_dir');
        await fsp.mkdir(tempDataDir,{recursive: true});
        await fsp.chown(tempDataDir,1000,1000);
        await fsp.chmod(tempDataDir,'775');
        const skelDir = path.resolve(`./docker_run/skel`);
        // await fsp.cp(skelDir,tempDataDir,{recursive: true, force: false});
        //cp -aT docker_run/skel_full2/ sessions/sess_14/test_dir/
        await execCmd('cp',["-aT",skelDir,tempDataDir]);


        const systemDir = path.join(sessPath,'system');
        await fsp.mkdir(systemDir,{recursive: true});
        await fsp.chown(systemDir,1000,1000);

        const imageDomainRE = new RegExp("^domain_([a-zA-Z0-9\.]+)");
        const m = imageDomainRE.exec(_imageName);
        let copiedPackagesFile = false;
        if (m && m[1]) {
            let domain = m[1];
            let packagesListDir;
            try {
                packagesListDir = path.resolve("./apks",domain);
                logger.info(`Copy packages files from domain dir: ${packagesListDir}`);
                await fsp.cp(path.join(packagesListDir,"packages.xml"),path.join(systemDir,"packages.xml"));
                await fsp.chown(path.join(systemDir,"packages.xml"),1000,1000);
                await fsp.cp(path.join(packagesListDir,"packages.list"),path.join(systemDir,"packages.list"));
                await fsp.chown(path.join(systemDir,"packages.list"),1000,1000);
                await fsp.cp(path.join(packagesListDir,"nubo_platform.version"),path.join(systemDir,"nubo_platform.version"));
                await fsp.chown(path.join(systemDir,"nubo_platform.version"),1000,1000);
                let nuboPackagesFile = path.join(packagesListDir,"nubo_packages.list");
                if (await Common.fileExists(nuboPackagesFile)) {
                    logger.info(`Copy nubo_packages.list from domain dir: ${packagesListDir}`);
                    await fsp.cp(nuboPackagesFile,path.join(systemDir,"nubo_packages.list"));
                    await fsp.chown(path.join(systemDir,"nubo_packages.list"),1000,1000);
                }
                copiedPackagesFile = true;
            } catch (err) {
                logger.info(`Unable to copy packages files from ${packagesListDir}. error: ${err}`);
            }
        }

        if (!copiedPackagesFile) {
            logger.info(`Copy packages files from skel dir`);
            try {
                await fsp.cp(path.join(skelDir,"system","packages.xml"),path.join(systemDir,"packages.xml"));
                await fsp.chown(path.join(systemDir,"packages.xml"),1000,1000);
                await fsp.cp(path.join(skelDir,"system","packages.list"),path.join(systemDir,"packages.list"));
                await fsp.chown(path.join(systemDir,"packages.list"),1000,1000);
                await fsp.cp(path.join(skelDir,"system","nubo_platform.version"),path.join(systemDir,"nubo_platform.version"));
                await fsp.chown(path.join(systemDir,"nubo_platform.version"),1000,1000);
            } catch (err) {
                logger.info(`Unable to copy packages files from skel dir. error: ${err}`);
            }
        }
        logger.logTime(`Finish copy pooled session files`);





        session.params.tempDataDir = tempDataDir;
        session.params.volumes = [];

        session.params.sessPath = sessPath;
        session.params.apksPath = apksPath;
        session.params.platformStartFile = platformStartFile;
        session.params.multiUser = multiUser;


        // logger.info(`Create local data volume for temp session`);
        // const imgFilePath = path.join(sessPath,'temp_data.img'); //path.resolve(`./sessions/temp_data_${unum}.img`);
        // const skelFile = path.resolve(`./docker_run/skel.img`);
        // await fsp.copyFile(skelFile,imgFilePath);

        // let losetupres =  await execCmd('losetup',["-f",imgFilePath,"--show"]);
        // let loopDeviceNum = losetupres.stdout.trim();
        // session.params.loopDevices = [loopDeviceNum];


        // let vol_data = await docker.createVolume({
        //     Name: "nubo_" + session.params.localid + "_temp_data",
        //     DriverOpts : {
        //         device: loopDeviceNum,
        //         type: "ext4"
        //     }
        // });

        // session.params.volumes = [vol_data.name];
        session.params.docker_image = _imageName;
        await saveUserSessionPromise(unum, session);

        // get user image from registry
        let imageName = `${registryURL}/nubo/${_imageName}`; // nubo-android-10
        logger.info(`Pulling user image: ${imageName}`);
        await pullImage(imageName);
        logger.logTime(`Finished image pull`);


        // creating container
        const dockerRunDir = path.resolve("./docker_run");
        logger.info(`Creating session container. dockerRunDir: ${dockerRunDir}`);
        logger.info(`attachUserDocker. session: ${JSON.stringify(session,null,2)}`);
        let startArgs = [
            'run', '-d',
            '--name', 'nubo_' + session.params.localid + "_android",
            '--privileged', '--security-opt', 'label=disable',
            '--env-file','env',
            '--network', 'net_sess',
        ];

        let mountArgs = [
                '-v', '/lib/modules:/system/lib/modules:ro',
                // '-v',`${vol_data.name}:/data`,
                '-v',`${externalSessPath}:/nubo:rw,rshared`,
                '-v',`${externalTempDataDir}:/data:rw,rshared`,

        ];
        let cmdArgs = ['/init'];
        let args = startArgs.concat(mountArgs, imageName, cmdArgs);
        await saveUserSessionPromise(unum, session);
        // console.log("start docker args: ", args);
        const runRes = await execDockerCmd(
            args,{cwd: dockerRunDir}
        );

        const containerID = runRes.stdout.trim();

        session.params.containerId = containerID;

        // get container ip
        let sesscontainer = await docker.getContainer(containerID);
        let cinsp = await sesscontainer.inspect();
        session.params.ipAddress = cinsp.NetworkSettings.Networks["net_sess"].IPAddress;
        await saveUserSessionPromise(unum, session);


        logger.logTime(`Finished container start`);
        await waitForPlatformStartPhase(session,"BOOT_COMPLETED user #0",logger);

        // // wait for launcher to start
        // let started = false;
        // let cnt = 0;
        // let system_server = "system_server";

        // logger.info(`Waiting for system_server to start..`);
        // while (!started && cnt < 200) {
        //     cnt++;
        //     let resps = await execDockerWaitAndroid(
        //         ['exec' , containerID, 'ps', '-A' ]
        //     );
        //     if (resps.stdout && resps.stdout.indexOf(system_server) >= 0) {
        //         started = true;
        //     } else {
        //         sleep(500);
        //     }
        // }
        // // kill bootanimation to reduce cpu
        // try {
        //     await execDockerWaitAndroid(
        //         ['exec' , containerID, 'pkill', 'bootanimation' ]
        //     );
        // } catch(err) {
        //     logger.info(`pkill bootanimation error: ${err}`);
        // }

        if (multiUser) {
            // create new nubo user
            // logger.info(`Waiting before create-user`);
            // await sleep(4000);
            // logger.info(`Running create-user...`);
            // await execDockerWaitAndroid(
            //     ['exec' , containerID, 'pm', 'create-user', 'nubo' ]
            // );
        }

        // if (doNotAddToPull == undefined || !doNotAddToPull) {
        //     const lockMachine2 = new Lock("machine");
        //     await lockMachine2.acquire();
        //     try {
        //         let machineConf = machineModule.getMachineConf();
        //         if (!machineConf.pooledSessions) {
        //             machineConf.pooledSessions = [];
        //         }
        //         machineConf.pooledSessions.push(unum);
        //         await machineModule.saveMachineConf(machineConf);
        //     } finally {
        //         lockMachine2.release();
        //     }
        // } else {
        //     logger.info(`Created pooled session without adding to pool`);
        // }





        logger.logTime(`Pooled session created on platform. unum: ${unum}, containerID: ${containerID}`);
        return session;
    } catch (err) {
        logger.error(`createPooledSession. Error: ${err}`,err);
        console.error(err);
        try {
            await saveUserSessionPromise(unum,session);
            lockSess.release();
            await detachUserDocker(unum);
        } catch (e2) {
            logger.error(`createPooledSession. detachUserDocker failed: ${e2}`,e2);
        }
    } finally {
        lockSess.release();
    }
}


async function attachUserDocker(obj,logger) {
    if (!logger) {
        logger = new ThreadedLogger(Common.getLogger(__filename));
    }

    //logger.info(`attachUserDocker. obj: ${JSON.stringify(obj,null,2)}`);
    let result = {

    };
    let logMeta = {
        user: obj.login.email,
        mtype: "important"
    }
    let session = {
        login: obj.login,
        logger: logger,
        nfs: obj.nfs,
        mounts: obj.mounts,
        params: obj.session,
        firewall: obj.firewall,
        platformSettings: obj.platformSettings,
        xml_file_content: obj.xml_file_content
    };
    let unum;
    if (session.login.deviceType != "Desktop") {
        //const pool = getOrCreatePool(session.params.docker_image);
        logger.info(`attachUserDocker. Getting pooled session`);
        let pooledSession = await getSessionFromPool(session.params.docker_image);
        unum = pooledSession.params.localid;
        logger.info(`attachUserDocker. Using pooled session. unum: ${unum}`);
        _.extend(session.params, pooledSession.params);
         session.params.pooledSession = true;
    }
    let linuxUserName;
    let registryURL;
    let lockMachine1 = new Lock("machine");
    await lockMachine1.acquire();
    try {
        let machineConf = machineModule.getMachineConf();
        // if (session.login.deviceType != "Desktop" && machineConf.pooledSessions && machineConf.pooledSessions.length > 0) {
        //     unum =  machineConf.pooledSessions.shift();
        //     let pooledSession = await loadUserSessionPromise(unum,logger);
        //     if (pooledSession.params.docker_image == session.params.docker_image) {
        //         logger.info(`attachUserDocker. Using pooled session. unum: ${unum}`);
        //         _.extend(session.params, pooledSession.params);
        //         session.params.pooledSession = true;
        //     } else {
        //         logger.info(`attachUserDocker. Not using pooled session. docker image is not the same: ${pooledSession.params.docker_image} != ${session.params.docker_image}`);
        //         machineConf.pooledSessions.unshift(unum);
        //         unum = undefined;
        //     }
        //     // logger.info(`attachUserDocker. merged session object: ${JSON.stringify(session,null,2)}`);
        // }
        if (!unum && session.login.deviceType == "Desktop") {
            // get new unum
            unum = machineConf.unumCnt;
            if (isNaN(unum) || unum == 0) {
            unum = 10;
            }
            machineConf.unumCnt = unum + 1;
        } else if (!unum) {
            throw new Error(`Not found pooled session!`);
            // in mobile create a new pooled session
            // logger.info(`attachUserDocker. Not found pooled session. create new one`);
            // // temporarely lift lock
            // let pooledSession;
            // lockMachine1.release();
            // try {
            //     pooledSession = await createPooledSession(session.params.docker_image,true,lockMachine1);
            //     if (!pooledSession) {
            //         throw new Error("Cannot create pooled session");
            //     }
            // } finally {
            //     lockMachine1 = new Lock("machine");
            //     await lockMachine1.acquire();
            // }
            // unum = pooledSession.params.localid;
            // logger.info(`attachUserDocker. Using pooled session. unum: ${unum}`);
            // _.extend(session.params, pooledSession.params);
            // session.params.pooledSession = true;
        }
        linuxUserName = getLinuxUserName(obj.login.email,unum,machineConf);

        result.unum = unum;
        registryURL = machineConf.registryURL;


        session.params.localid = unum;
        session.params.tz = obj.timeZone;
        session.params.createSessionTime = new Date();
        lastCreateSessionTime = session.params.createSessionTime.getTime();
        if (!machineConf.sessions) {
            machineConf.sessions = {};
        }
        let sessKey = `${session.params.email}_${session.params.deviceid}`;
        machineConf.sessions[sessKey] = {
            localid: unum,
            email: session.params.email,
            deviceid: session.params.deviceid
        }
        session.params.sessKey = sessKey;
        await machineModule.saveMachineConf(machineConf);

    } finally {
        lockMachine1.release();
    }

    const lockSess = new Lock(`sess_${unum}`);
    try {
        await lockSess.acquire();
        if (session.login.deviceType == "Desktop") {


            session.params.linuxUserName = linuxUserName;
            session.params.userPass = makeid(16);
            session.params.locale = `${session.login.lang}_${session.login.countrylang}.UTF-8`;

            logger.log('info', "Mount user home folder");
            await mount.linuxMount(session);
            logger.log('info', `User home folder mounted at ${session.params.homeFolder}`, logMeta);

            await saveUserSessionPromise(unum, session);


            //let imageName = registryURL + '/nubo/nuboxrdp:latest';
            let imageName = `${registryURL}/nubo/${session.params.docker_image}`;
            logger.log('info', `Pulling user image: ${imageName}`, logMeta);
            await pullImage(imageName);

            logger.info(`Creating session container`);
            let container;
            try {
                container = await docker.createContainer({
                    Image: imageName,
                    AttachStdin: false,
                    AttachStdout: true,
                    AttachStderr: true,
                    Tty: true,
                    OpenStdin: false,
                    StdinOnce: false,
                    HostConfig: {
                        Binds: [
                            `${session.params.homeFolder}:/home/${linuxUserName}`
                        ],
                        NetworkMode: "net_sess",
                        //Privileged: true
                    }
                });
            } catch (err) {
                logger.info(`createContainer failed: ${err}`);
                console.error(err);
                throw new Error("createContainer failed");
            }
            //console.log(`container created: ${JSON.stringify(container,null,2)}`);
            logger.log('info', `Container created: ${container.id}`, logMeta);
            //let stream = await container.attach({stream: true, stdout: true, stderr: true});
            //stream.pipe(process.stdout);
            let data = await container.start();
            //console.log(`container started: ${JSON.stringify(data, null, 2)}`);


            let sesscontainer = await docker.getContainer(container.id);
            let cinsp = await sesscontainer.inspect();
            let ipAddress = cinsp.NetworkSettings.Networks["net_sess"].IPAddress;
            //console.log(`container inspect: ${JSON.stringify(cinsp,null,2)}`);
            //console.log(`container inspect: ${JSON.stringify(sesscontainer,null,2)}`);

            // create firewall rules if needed
            if (session.firewall && session.firewall.enabled) {
                try {
                    logger.log('info',`Assign firewall rules`);
                    const NUBO_USER_CHAIN = "NUBO-USER";
                    let chains = await getRules();
                    let rules = chains[NUBO_USER_CHAIN];
                    if (rules) {
                        console.log(`Found NUBO-USER chain with ${chains["NUBO-USER"].length} items`);
                    } else {
                        console.log(`NUBO-USER chain not found. Creating new chain`);
                        await createChain(NUBO_USER_CHAIN);
                        await insertRule(NUBO_USER_CHAIN,null,['-j','RETURN']); // drop all incoming traffic to ip
                        let fwdRules = chains['FORWARD'];
                        let num;
                        let foundNuboUser = false;
                        for (const rule of fwdRules) {
                            if (rule.target == "DOCKER-ISOLATION-STAGE-1") {
                                num = rule.num + 1;
                            }
                            if (rule.target == NUBO_USER_CHAIN) {
                                foundNuboUser = true;
                                break;
                            }
                        }
                        if (num && !foundNuboUser) {
                            await insertRule('FORWARD',num,['-j',NUBO_USER_CHAIN]); // go to chain NUBO-USER from FORWARD chain
                        }
                        rules = [];
                    }

                    // delete old rules of this ip address
                    for (let i = rules.length-1; i>=0 ; i--) {
                        const rule = rules[i];
                        if (rule.source == ipAddress || rule.destination == ipAddress)  {
                            console.log(`Delete rule: ${JSON.stringify(rule)}`);
                            await deleteRule(NUBO_USER_CHAIN,rule.num);
                        }
                    }

                    // insert default rules -- block all outgoing/incoming traffic
                    await insertRule(NUBO_USER_CHAIN,null,['-d',ipAddress,'-j','DROP']); // drop all incoming traffic to ip
                    await insertRule(NUBO_USER_CHAIN,null,['-d',ipAddress,'-m','conntrack','--ctstate','ESTABLISHED','-j','ACCEPT']); // allow incoming established
                    await insertRule(NUBO_USER_CHAIN,null,['-d',ipAddress,'-p','tcp','--dport','3389','-j','ACCEPT']); // allow incoming rdp connection
                    await insertRule(NUBO_USER_CHAIN,null,['-s',ipAddress,'-j','DROP']); // drop all outgoing traffic from ip
                    await insertRule(NUBO_USER_CHAIN,null,['-s',ipAddress,'-m','conntrack','--ctstate','ESTABLISHED','-j','ACCEPT']); // allow outgoinf established
                    let addedRules = 0;
                    // add aditional outgoing rules
                    for (const rule of session.firewall.rules) {
                        let ruleparams = ['-s',ipAddress];
                        if (rule.destination) {
                            ruleparams.push('-d',rule.destination);
                        }
                        if (rule.prot) {
                            ruleparams.push('-p',rule.prot);
                        }
                        if (rule.dport && rule.dport > 0) {
                            ruleparams.push('--dport',rule.dport);
                        }
                        ruleparams.push('-j','ACCEPT');
                        await insertRule(NUBO_USER_CHAIN,null,ruleparams); // add rule
                        addedRules++;
                    }
                    logger.info(`Added ${addedRules} custom firewall rules`);
                    //await insertRule(NUBO_USER_CHAIN,null,['-s',ipAddress,'-d','159.89.188.39','-p','tcp','--dport','443','-j','ACCEPT']); // sampe rule to nubo website


                } catch (err) {
                    logger.error(`Firewall create error: ${err}`,err);
                    throw new Error(`Firewall create error: ${err}`);
                }
            }


            const { stdout, stderr } = await execDockerCmd(
                ['exec', container.id, '/usr/bin/create_rdp_user.sh',
                    linuxUserName,
                    session.params.userPass,
                    session.params.tz,
                    session.params.locale
                ]
            );
            //console.log(`Crete user. stdout: ${stdout}\n stderr: ${stderr}`);

            let xrdpStarted = false;
            let startTime = Date.now();
            do {
                try {
                    await sleep(300);
                    //console.log(`check for supervisord.log`);
                    const logRes = await execDockerCmd(
                        ['exec', container.id, 'tail', '-10',
                            '/var/log/supervisor/supervisord.log'
                        ]
                    );
                    //console.log(`supervisord.log: ${JSON.stringify(logRes,null,2)}`);
                    xrdpStarted = (logRes.stdout.indexOf("spawned: 'xrdp-sesman' with pid") >= 0);
                } catch (e) {
                    //console.error(e);
                }


            } while (!xrdpStarted && (Date.now() - startTime) < 30000);


            //console.log(`IP: ${ipAddress}, User: ${linuxUserName}, Password: ${session.params.userPass}`);
            result.ipAddress = ipAddress;
            result.linuxUserName = linuxUserName;
            result.userPass = session.params.userPass;
            //logger.info(`Session created with active user: ${JSON.stringify(result,null,2)}`);
            logger.log('info', `Session created on platform. ipAddress: ${ipAddress}, linuxUserName: ${linuxUserName}`, logMeta);
            session.params.ipAddress = ipAddress;
            session.params.containerId = container.id;
        } else { // mobile user with docker

            let sessPath = session.params.sessPath;
            if (!sessPath) {
                sessPath = path.resolve(`./sessions/sess_${unum}`);
                let externalSessPath;
                if (Common.externalPath) {
                    externalSessPath = path.join(Common.externalPath,'sessions',`sess_${unum}`);
                } else {
                    externalSessPath = sessPath;
                }
                let apksPath = path.join(sessPath,'apks');
                await fsp.mkdir(apksPath,{recursive: true});
                await fsp.chown(sessPath,1000,1000);
                session.params.sessPath = sessPath;
                session.params.apksPath = apksPath;
            }
            // mount user folder
            logger.log('info', "Mount user home folder");
            await mount.mobileMount(session);
            logger.logTime(`User home folder mounted at ${session.params.homeFolder}`);


            // mount data.img as loop device
            // const imgFilePath = path.join(session.params.homeFolder,'data.img');
            // let losetupres =  await execCmd('losetup',["-f",imgFilePath,"--show"]);
            // let loopDeviceNum = losetupres.stdout.trim();
            // if (!session.params.loopDevices) {
            //     session.params.loopDevices = [];
            // }
            // session.params.loopDevices.push(loopDeviceNum);

            let syncAccountsFile;
            let syncBackupFile;

            if (session.params.pooledSession) {
                // let stats = await fsp.stat(loopDeviceNum);
                // let major = (stats.rdev >> 8 );
                // let minor = (stats.rdev & 0xFF );
                await saveUserSessionPromise(unum, session);
                // let zygotePid;
                // let resps = await execDockerWaitAndroid(
                //     ['exec' , session.params.containerId, 'ps', '-A', '-o' ,'PID,NAME' ]
                // );
                // let lines = resps.stdout.split('\n');
                // const pName = "system_server"; //"zygote64";
                // for (const line of lines) {
                //     let fields = line.trim().split(' ');
                //     if (fields[1] == pName) {
                //         zygotePid = fields[0];
                //         break;
                //     }
                // }
                // if (!zygotePid) {
                //     throw new Error(`${pName} not found in pooled container`);
                // }
                // logger.logTime(`${pName} pid: ${zygotePid}`);

                if (!session.params.mounts) {
                    session.params.mounts = [];
                }

                if (session.xml_file_content) {
                    let sessionXMLFile = path.join(session.params.sessPath,"Session.xml");
                    logger.info(`Found xml_file_content. write to: ${sessionXMLFile}`);
                    await fsp.writeFile(sessionXMLFile,session.xml_file_content);
                    await fsp.chown(sessionXMLFile,1000,1000);
                    await fsp.chmod(sessionXMLFile,'600');
                } else {
                    let errmsg = `Not found xml_file_content in session params!`;
                    logger.info(errmsg);
                    throw new Error(errmsg);
                }
                let platformStartFile = session.params.platformStartFile;
                await fsp.appendFile(platformStartFile, `${moment().utc().format('YYYY-MM-DD HH:mm:ss')} Starting session\n`, 'utf-8');

                let storagePath = path.join(session.params.sessPath,"storage");

                if (session.params.nfsHomeFolder != "local") {
                    logger.log('info', "Mount storage folder");
                    logger.info(`mount storage. remote: ${session.params.nfsStorageFolder}, local: ${storagePath} `);
                    await mount.mountFolder(session.params.nfsStorageFolder,storagePath);
                    session.params.mountedStorageFolder = storagePath;
                    session.params.mounts.push(storagePath);
                } else {
                    logger.log('info', `Using local folder for storage: ${session.params.storageFolder}`);
                    try {
                        await fsp.mkdir(storagePath,{recursive: true});
                        await execCmd('mount',["--bind",session.params.storageFolder,storagePath]);
                        session.params.mountedStorageFolder = storagePath;
                        session.params.mounts.push(storagePath);
                    } catch (err) {
                        logger.info(`Unable to mount bind storage folder. err: ${err}`);
                    }

                }
                if (session.params.recording && session.params.recording_path) {
                    let recordingPath = path.join(session.params.sessPath,"recording");
                    if (session.params.nfsHomeFolder != "local") {
                        let nfslocation = session.nfs.nfs_ip + ":" + session.params.recording_path + "/";
                        logger.log('info', `Mount recording folder from: ${nfslocation}`);
                        try {
                            await mount.mountFolder(nfslocation,recordingPath);
                            session.params.mounts.push(recordingPath);
                        } catch (err) {
                            logger.info(`Unable to mount nfs recording folder. err: ${err}`);
                        }
                    } else {
                        logger.log('info', `Using local folder for recording: ${session.params.recording_path}`);
                        try {
                            await fsp.mkdir(recordingPath,{recursive: true});
                            await execCmd('mount',["--bind",session.params.recording_path,recordingPath]);
                            session.params.mounts.push(recordingPath);
                        } catch (err) {
                            logger.info(`Unable to mount bind recording folder. err: ${err}`);
                        }
                    }
                }
                await saveUserSessionPromise(unum, session);
                logger.logTime(`Create swap user in container ${session.params.containerId} `);

                // let sessionPendingFile = session.params.sessionPendingFile;
                // let multiUser = session.params.multiUser;
                // if (!multiUser && sessionPendingFile) {
                //     // // create a file for the loop device
                //     // await execDockerWaitAndroid(
                //     //     ['exec' , session.params.containerId, 'mknod', '/dev/d.img', 'b' , `${major}` , `${minor}` ]
                //     // );

                //     // // unmount the temp /data folder
                //     // await execDockerWaitAndroid(
                //     //     ['exec' , session.params.containerId, 'umount', '-l', '/data' ]
                //     // );

                //     // // mount the new data folder
                //     // await execDockerWaitAndroid(
                //     //     ['exec' , session.params.containerId, 'mount', '/dev/d.img', '/data' ]
                //     // );

                //     // // mount the sdcard
                //     // try {
                //     //     await execDockerWaitAndroid(
                //     //         ['exec' , session.params.containerId, 'mount', '--bind', '/nubo/storage', '/data/media' ]
                //     //     );
                //     // } catch (err) {
                //     //     logger.info(`Error mount /data/media: ${err}`);
                //     // }

                //     // // restart keystore
                //     // await execDockerWaitAndroid(
                //     //     ['exec' , session.params.containerId, 'pkill', 'keystore' ]
                //     // );

                //     // delete the session_pending file
                //     await execDockerWaitAndroid(
                //         ['exec' , session.params.containerId, 'sh', '-e' , '/system/etc/login_user.sh' , `${major}` , `${minor}`  ]
                //     );
                //     await fsp.unlink(sessionPendingFile);

                // // // restart zygote
                // // await execDockerWaitAndroid(
                // //     ['exec' , session.params.containerId, 'kill', `${zygotePid}` ]
                // // );
                // } else if (!multiUser) {

                //     // run login script
                //     let loginScriptSuccess = false;
                //     let loginCnt = 0;

                //     while (!loginScriptSuccess && loginCnt<10) {
                //         try {
                //             loginCnt++;
                //             await execDockerWaitAndroid(
                //                 ['exec' , session.params.containerId, 'sh', '-e' , '/system/etc/login_user.sh' , `${major}` , `${minor}`  ]
                //             );
                //             loginScriptSuccess = true;
                //         } catch (err) {
                //             logger.error(`attachUserDocker. login_user.sh Error: ${err}`);
                //             if (loginCnt<10) {
                //                 await sleep(500);
                //             } else {
                //                 throw err;
                //             }
                //         }
                //     }
                // } else { // multiUser == true

                    // let sessHomeFolder = path.join(session.params.sessPath,`home`);
                    // await fsp.mkdir(sessHomeFolder,{recursive: true});
                    // await execCmd('mount',["--bind",session.params.homeFolder,nuboHomeFolder]);
                    // session.params.tempDataDir


                    // mount user image
                    const imageFile =  path.join(session.params.homeFolder,"user.img");
                    if (!await Common.fileExists(imageFile)) {
                        logger.info(`Image does not exists - create it`);
                        await execCmd('dd',["if=/dev/zero", `of=${imageFile}`, "bs=1M", "count=250"]);
                        await execCmd('mkfs.ext4',[imageFile]);
                        await execCmd('tune2fs',["-c0","-i0",imageFile]);
                        logger.info(`Image creted at: ${imageFile}`);
                    }

                    // mount user.img into /nubo.user_img
                    const imageMntDir = path.join(session.params.sessPath,"user_img");
                    await fsp.mkdir(imageMntDir,{recursive: true});
                    logger.info(`Mounting user image: ${imageFile} to ${imageMntDir}`);
                    await execCmd('mount',[imageFile,imageMntDir]);
                    session.params.mounts.push(imageMntDir);
                    session.params.userImageFile = imageFile;

                    logger.logTime(`replacing user 10 folders..`);
                    const srcFolders = [
                        'misc',
                        'misc_ce',
                        'misc_de',
                        'misc_keystore',
                        'system/users',
                        'system_ce',
                        'system_de',
                        'user',
                        'user_de',
                        'sync'
                    ];
                    const dstFolders = [
                        'misc/user/10',
                        'misc_ce/10',
                        'misc_de/10',
                        'misc/keystore/user_10',
                        'system/users/10',
                        'system_ce/10',
                        'system_de/10',
                        'user/10',
                        'user_de/10',
                        'system/sync'
                    ];


                    let mountFolder = async function (src,dst) {
                        if (!await Common.fileExists(src)) {
                            logger.info(`User folder does not exists: ${src}. Copy skel folder ${dst} into it.`);
                            await fsp.mkdir(src,{recursive: true});
                            await execCmd('cp',["-aT",dst,src]);
                            const stats = await fsp.stat(src);
                            const mode = '0' + (stats.mode & parseInt('777', 8)).toString(8);
                            //logger.info(`After copy folder. mode: ${mode}, stats: ${JSON.stringify(stats,null,2)}`);
                        }

                        logger.info(`Mount user folder ${src} to ${dst}`);
                        await fsp.rm(dst,{recursive: true});
                        await fsp.mkdir(dst,{recursive: true});
                        await execCmd('mount',["--bind",src,dst]);
                        session.params.mounts.push(dst);
                    }

                    for (let i=0; i<dstFolders.length; i++) {
                        const src = path.join(imageMntDir,srcFolders[i]);
                        const dst = path.join(session.params.tempDataDir,dstFolders[i]);
                        await mountFolder(src,dst);
                    }


                    const storageSrc = path.join(session.params.mountedStorageFolder,"media");
                    const storageDst = path.join(session.params.tempDataDir,"media","10");
                    await mountFolder(storageSrc,storageDst);

                    // fsync mounted system_ce
                    // logger.logTime(`fsync mounted system_ce`);
                    // await execCmd('sync',[]);
                    // logger.logTime(`fsync finished`);


                    // add firewall rules
                    await createFirewallForSession(session,logger);


                    //copy files updates
                    await copyUpdatFilesToSession(session);


                    // save backup of system/sync/accounts.xml
                    const syncDir = path.join(session.params.tempDataDir,"system","sync");
                    syncAccountsFile = path.join(syncDir,"accounts.xml");
                    syncBackupFile = path.join(syncDir,"accounts-bak.xml");
                    if (await Common.fileExists(syncAccountsFile)) {
                        logger.info(`Backup accounts.xml to ${syncBackupFile}`);
                        await fsp.cp(syncAccountsFile,syncBackupFile);
                        await fsp.chown(syncBackupFile,1000,1000);
                    }


                    // run am stop-user to close accounts_de
                    await execDockerWaitAndroid(
                        ['exec' , session.params.containerId, 'am', 'stop-user', '10' ]
                    );


                    logger.info(`Running pm refresh..`);
                    await execDockerWaitAndroid(
                        ['exec' , session.params.containerId, 'pm', 'refresh' , '10' , session.params.keystoreKey  ]
                    );



                    logger.info(`Running am switch-user..`);
                    await execDockerWaitAndroid(
                        ['exec' , session.params.containerId, 'am', 'switch-user' , '10'  ]
                    );

                // }


                logger.logTime(`After init user`);

                if(session.params.audioStreamParams) {
                    await Audio.initAudio(unum);
                }

            } else {
                throw new Error(`Cannot start user session without pooled session`);
                // let multiUser = (Common.sessionPool && Common.sessionPool.multiUser != undefined ? Common.sessionPool.multiUser : false);


                // logger.log('info', `Create local volume for ${loopDeviceNum}`);

                // let vol_data = await docker.createVolume({
                //     Name: "nubo_" + session.params.localid + "_data",
                //     DriverOpts : {
                //         device: loopDeviceNum,
                //         type: "ext4"
                //     }
                // });

                // session.params.volumes = [vol_data.name];

                // let platformStartFile = path.join(sessPath,'platformStart.log');
                // await fsp.appendFile(platformStartFile, `${moment().utc().format('YYYY-MM-DD HH:mm:ss')} Starting session\n`, 'utf-8');
                // await fsp.chown(platformStartFile,1000,1000);
                // await fsp.chmod(platformStartFile,'660');
                // session.params.platformStartFile = platformStartFile;

                // await saveUserSessionPromise(unum, session);

                // if (session.xml_file_content) {
                //     let sessionXMLFile = path.join(session.params.sessPath,"Session.xml");
                //     // logger.info(`Found xml_file_content. write to: ${sessionXMLFile}, xml_file_content: ${session.xml_file_content}`);
                //     await fsp.writeFile(sessionXMLFile,session.xml_file_content);
                //     await fsp.chown(sessionXMLFile,1000,1000);
                //     await fsp.chmod(sessionXMLFile,'600');
                // } else {
                //     let errmsg = `Not found xml_file_content in session params!`;
                //     logger.info(errmsg);
                //     throw new Error(errmsg);
                // }

                // if(session.params.audioStreamParams) {
                //     await Audio.initAudio(unum);
                // }

                // // get user image from registry
                // let imageName = `${registryURL}/nubo/${session.params.docker_image}`;
                // logger.log('info', `Pulling user image: ${imageName}`, logMeta);
                // await pullImage(imageName);

                // // creating container
                // const dockerRunDir = path.resolve("./docker_run");
                // // const apksDir = path.resolve(`./sessions/apks_${unum}`);
                // // await fsp.mkdir(apksDir,{recursive: true});
                // logger.info(`Creating session container. dockerRunDir: ${dockerRunDir}`);
                // logger.info(`attachUserDocker. session: ${JSON.stringify(session,null,2)}`);
                // let vol_storage;
                // let storage_name;
                // if (session.params.nfsHomeFolder != "local") {
                //     logger.log('info', "Create NFS volume for storage");
                //     vol_storage = await docker.createVolume({
                //         Name: "nubo_" + session.params.localid + "_storage",
                //         DriverOpts : {
                //             device: session.params.nfsStorageFolder,
                //             o: "addr=" + session.nfs.nfs_ip,
                //             type: "nfs4"
                //         }
                //     });
                //     storage_name = vol_storage.name;
                //     session.params.volumes.push(vol_storage.name);
                // } else {
                //     storage_name = session.params.storageFolder;
                //     logger.log('info', `Using local folder for storage: ${storage_name}`);
                // }
                // let startArgs = [
                //         'run', '-d',
                //         '--name', 'nubo_' + session.params.localid + "_android",
                //         '--privileged', '--security-opt', 'label=disable',
                //         '--env-file','env',
                //         '--network', 'net_sess',
                // ];
                // let mountArgs = [
                //         //'--mount', 'type=tmpfs,destination=/dev,tmpfs-mode=0755',
                //         '-v', '/lib/modules:/system/lib/modules:ro',
                //         // '-v',`${apksDir}:/system/vendor/apks:ro`,
                //         '-v',`${vol_data.name}:/data`,
                //         '-v',`${storage_name}:/data/media`,
                //         '-v',`${externalSessPath}:/nubo:rw,rshared`,
                // ];
                // /*if(session.params.audioStreamParams) {
                //     if (Common.isDocker) {
                //         mountArgs.push(
                //             '-v', `/opt/nubo/platform_server/sessions/audio_in_${unum}:/nubo/audio_in:rw,rshared`,
                //             '-v', `/opt/nubo/platform_server/sessions/audio_out_${unum}:/nubo/audio_out:rw,rshared`
                //         );
                //     } else {
                //         mountArgs.push(
                //             '-v', `/opt/platform_server/sessions/audio_in_${unum}:/nubo/audio_in:rw,rshared`,
                //             '-v', `/opt/platform_server/sessions/audio_out_${unum}:/nubo/audio_out:rw,rshared`
                //         );
                //     }
                // }*/
                // if (session.params.recording && session.params.recording_path) {
                //     let recordingVolName ;
                //     if (session.params.nfsHomeFolder != "local") {
                //         let nfslocation = session.nfs.nfs_ip + ":" + session.params.recording_path + "/";
                //         logger.log('info', `Create NFS volume for recording at: ${nfslocation}`);
                //         let vol = await docker.createVolume({
                //             Name: "nubo_" + session.params.localid + "_recording",
                //             DriverOpts : {
                //                 device: nfslocation,
                //                 o: "addr=" + session.nfs.nfs_ip,
                //                 type: "nfs4"
                //             },
                //             //rw,rshared
                //         });
                //         recordingVolName = vol.name;
                //         session.params.volumes.push(vol.name);
                //     } else {
                //         recordingVolName = session.params.recording_path;
                //         logger.log('info', `Using local folder for recording: ${recordingVolName}`);
                //     }
                //     mountArgs.push(
                //         '-v', `${recordingVolName}:/nubo/recording`
                //     );
                // }
                // let cmdArgs = ['/init'];
                // let args = startArgs.concat(mountArgs, imageName, cmdArgs);
                // await saveUserSessionPromise(unum, session);
                // console.log("start docker args: ", args);
                // const runRes = await execDockerCmd(
                //     args,{cwd: dockerRunDir}
                // );

                // session.params.containerId = runRes.stdout.trim();

                // await saveUserSessionPromise(unum, session);
            }


            // wait for session to start
            // await waitForPlatformStartPhase(session,"User unlocked",logger);
            await waitForPlatformStartPhase(session,`BOOT_COMPLETED user #10`,logger);

            // if (syncBackupFile && await Common.fileExists(syncBackupFile)) {
            //     const syncBackup = await fsp.readFile(syncBackupFile,"utf8");
            //     const syncAccount = await fsp.readFile(syncAccountsFile,"utf8");
            //     if (syncBackup != syncAccount) {
            //         logger.info(`syncBackup != syncAccount\nsyncBackup: ${syncBackup}\nsyncAccount: ${syncAccount}`);
            //         await fsp.cp(syncBackupFile,syncAccountsFile);
            //         await fsp.chown(syncAccountsFile,1000,1000);
            //         await fsp.cp(syncBackupFile,syncAccountsFile+".bak2");
            //         await fsp.chown(syncAccountsFile+".bak2",1000,1000);
            //     }
            //     logger.info(`Running pm refresh 2..`);
            //     await execDockerWaitAndroid(
            //         ['exec' , session.params.containerId, 'pm', 'refresh' , '10' , session.params.keystoreKey  ]
            //     );
            //     // logger.info(`Delete syncBackupFile..`);
            //     // await fsp.unlink(syncBackupFile);

            // }
            // await waitForSessionStart(session.params.containerId,logger);
            // wait for launcher to start
            // let started = false;
            // let cnt = 0;
            // let wait_process;
            // // if (session.platformSettings && session.platformSettings.default_launcher) {
            // //     wait_process = session.platformSettings.default_launcher;
            // // } else {
            // //     wait_process = "com.nubo.launcher";
            // // }
            // wait_process = "com.android.systemui";
            // logger.logTime(`Waiting for ${wait_process} to start..`);
            // while (!started && cnt < 200) {
            //     cnt++;
            //     let resps = await execDockerWaitAndroid(
            //         ['exec' , session.params.containerId, 'ps', '-A' ]
            //     );
            //     if (resps.stdout && resps.stdout.indexOf(wait_process) >= 0) {
            //         started = true;
            //     } else {
            //         sleep(100);
            //     }
            // }


            logger.log('info', `Session created on platform. containerID: ${session.params.containerId}`, logMeta);

        }
        await saveUserSessionPromise(unum,session);
    } catch (err) {
        logger.error(`attachUserDocker. Error: ${err}`,err);
        try {
            await saveUserSessionPromise(unum,session);
            lockSess.release();
            await detachUserDocker(unum);
        } catch (e2) {
            logger.error(`attachUserDocker. detachUserDocker failed: ${e2}`,e2);
        }
        throw err;
    } finally {
        lockSess.release();
    }

    return result;
}


async function waitForPlatformStartPhase(session,waitMsg,logger) {

    // abort wait after 60 seconds
    const ac = new AbortController();
    const { signal } = ac;
    setTimeout(() => ac.abort(), 60000);

    if (!waitMsg) {
        waitMsg = "User unlocked";
    }

    logger.logTime(`Waiting for platform start phase: ${waitMsg}..`);

    const platformStartFile = session.params.platformStartFile;
    try {
        const watcher = fsp.watch(platformStartFile, { signal });
        let userStarted = false;
        while (!userStarted) {

            let data = await fsp.readFile(platformStartFile,"utf8");
            if (data.indexOf(waitMsg) > 0) {
                userStarted = true;
                logger.logTime(`Platform phase ready: ${waitMsg}.`);
                break;
            }
            // logger.logTime(`Platform user not started yet. Waiting..`);
            // wait for next change of file
            await watcher.next();
        }
    } catch (err) {
        logger.error(`waitForPlatformStartPhase error: ${err}`,err);
        return;
    }
}

async function waitForSessionStart(containerId,logger) {
    // wait for launcher to start
    try {
        let started = false;
        let cnt = 0;
        let wait_process;
        // if (session.platformSettings && session.platformSettings.default_launcher) {
        //     wait_process = session.platformSettings.default_launcher;
        // } else {
        //     wait_process = "com.nubo.launcher";
        // }
        wait_process = "com.android.systemui";
        logger.logTime(`Waiting for ${wait_process} to start..`);
        while (!started && cnt < 200) {
            cnt++;
            let resps = await execDockerWaitAndroid(
                ['exec' , containerId, 'ps', '-A' ]
            );
            if (resps.stdout && resps.stdout.indexOf(wait_process) >= 0) {
                started = true;
            } else {
                sleep(100);
            }
        }
        logger.logTime(`Finish waiting for session to start. started: ${started}`);
    } catch (err) {
        logger.error(`waitforSessionStart error: ${err}`,err);
    }
}

async function copyUpdatFilesToSession(session) {
    let packageList = [];
    try {
        const updatesFolder =  path.join(session.params.homeFolder,"updates");
        const updateFilesFile = path.join(updatesFolder,"updates.json");
        if (await Common.fileExists(updateFilesFile)) {
            const updateFiles = JSON.parse(await fsp.readFile(updateFilesFile,"utf8"));
            for (const updateFile of updateFiles) {
                try {
                    const src = path.join(updatesFolder,updateFile);
                    const stats = await fsp.stat(src);
                    const dst = path.join(session.params.tempDataDir,updateFile);
                    const mode = '0' + (stats.mode & parseInt('777', 8)).toString(8);
                    if (stats.isDirectory()) {
                        logger.info(`Create folder at: ${dst}, uid: ${stats.uid}, gid: ${stats.gid}, mode: ${mode}`);
                        await fsp.mkdir(dst,{recursive: true});
                    } else {
                        logger.info(`Copy update file from: ${src} to: ${dst}, uid: ${stats.uid}, gid: ${stats.gid}, mode: ${mode}`);
                        await fsp.cp(src,dst);
                        // check if the updateFile is a app restrictions file
                        // updateFile syntax: "/system/users/10/res_[package name].xml"
                        var re = new RegExp('/system/users/10/res_([A-Za-z\d_\.]+).xml');
                        var m = re.exec(updateFile);
                        if(m) {
                            let packageName = m[1];
                            logger.info(`Found updated restriction file: ${packageName}`);
                            packageList.push(packageName);
                        }
                        if (updateFile == "/user/10/com.nubo.nubosettings/startup/startup.json") {
                            logger.info(`Found updated startup.json file: com.nubo.nubosettings`);
                            packageList.push("com.nubo.nubosettings");
                        }
                    }
                    await fsp.chown(dst,stats.uid,stats.gid);
                    await fsp.chmod(dst,mode);
                    // await fsp.unlink(src);
                } catch (err) {
                    logger.error(`Error on update file: ${updateFile}, err: ${err}`,err);
                }
            }
            await fsp.rm(updatesFolder,{recursive: true});
        }
    } catch (err) {
        logger.error(`Error on copyUpdatFilesToSession files: ${err}`,err);
    }
    return packageList;
}



function execCmd(cmd,params) {
    return new Promise((resolve, reject) => {
        execFile(cmd, params, {maxBuffer: 1024 * 1024 * 10} , function (error, stdout, stderr) {
            if (error) {
                let e = new ExecCmdError(`${error}`,error,stdout,stderr);
                reject(e);
            }
            //logger.info("execCmd: " + "\'" + stdout + "\'");
            resolve({
                stdout,
                stderr
            });
            return;
        });
    });
}


function makeid(length) {
    var result = '';
    var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for (var i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() *
            charactersLength));
    }
    return result;
}


/**
 * Create firewall rules for new sessionss
 * @param {*} session
 */
async function createFirewallForSession(session,logger) {
    if (session.firewall && session.firewall.enabled) {
        try {
            let ipAddress = session.params.ipAddress;
            let isDesktop = (session.login.deviceType == "Desktop");
            if (!ipAddress) {
                throw new Error("ipAddress not found for session");
            }
            logger.log('info',`Assign firewall rules`);
            const NUBO_USER_CHAIN = "NUBO-USER";
            let chains = await getRules();
            let rules = chains[NUBO_USER_CHAIN];
            if (rules) {
                console.log(`Found NUBO-USER chain with ${chains["NUBO-USER"].length} items`);
            } else {
                console.log(`NUBO-USER chain not found. Creating new chain`);
                await createChain(NUBO_USER_CHAIN);
                await insertRule(NUBO_USER_CHAIN,null,['-j','RETURN']); // drop all incoming traffic to ip
                let fwdRules = chains['FORWARD'];
                let num;
                let foundNuboUser = false;
                for (const rule of fwdRules) {
                    if (rule.target == "DOCKER-ISOLATION-STAGE-1") {
                        num = rule.num + 1;
                    }
                    if (rule.target == NUBO_USER_CHAIN) {
                        foundNuboUser = true;
                        break;
                    }
                }
                if (num && !foundNuboUser) {
                    await insertRule('FORWARD',num,['-j',NUBO_USER_CHAIN]); // go to chain NUBO-USER from FORWARD chain
                }
                rules = [];
            }

            // delete old rules of this ip address
            for (let i = rules.length-1; i>=0 ; i--) {
                const rule = rules[i];
                if (rule.source == ipAddress || rule.destination == ipAddress)  {
                    console.log(`Delete rule: ${JSON.stringify(rule)}`);
                    await deleteRule(NUBO_USER_CHAIN,rule.num);
                }
            }

            // insert default rules -- block all outgoing/incoming traffic
            await insertRule(NUBO_USER_CHAIN,null,['-d',ipAddress,'-j','DROP']); // drop all incoming traffic to ip
            await insertRule(NUBO_USER_CHAIN,null,['-d',ipAddress,'-m','conntrack','--ctstate','ESTABLISHED','-j','ACCEPT']); // allow incoming established
            if (isDesktop) {
                await insertRule(NUBO_USER_CHAIN,null,['-d',ipAddress,'-p','tcp','--dport','3389','-j','ACCEPT']); // allow incoming rdp connection
            }
            await insertRule(NUBO_USER_CHAIN,null,['-s',ipAddress,'-j','DROP']); // drop all outgoing traffic from ip
            await insertRule(NUBO_USER_CHAIN,null,['-s',ipAddress,'-m','conntrack','--ctstate','ESTABLISHED','-j','ACCEPT']); // allow outgoinf established
            let addedRules = 0;

            // add aditional outgoing rules
            for (const rule of session.firewall.rules) {
                let ruleparams = ['-s',ipAddress];
                if (rule.destination) {
                    const rangearr = rule.destination.split('-');
                    if (rangearr.length == 2) {
                        ruleparams.push('-m','iprange','--dst-range',rule.destination);
                    } else {
                        ruleparams.push('-d',rule.destination);
                    }
                }
                if (rule.prot) {
                    ruleparams.push('-p',rule.prot);
                }
                if (rule.dport && rule.dport > 0) {
                    ruleparams.push('--dport',rule.dport);
                }
                ruleparams.push('-j','ACCEPT');
                await insertRule(NUBO_USER_CHAIN,null,ruleparams); // add rule
                addedRules++;
            }
            logger.info(`Added ${addedRules} custom firewall rules`);


        } catch (err) {
            logger.error(`Firewall create error: ${err}`,err);
            throw new Error(`Firewall create error: ${err}`);
        }
    }
}


async function fastDetachUserDocker(unum) {
    let waitForFullDetach = true;
    // let logger = Common.getLogger(__filename);
    let logger = new ThreadedLogger(Common.getLogger(__filename));
    logger.info(`fastDetachUserDocker. unum: ${unum} `);
    const lockSess = new Lock(`sess_${unum}`);
    try {
        await lockSess.acquire();
        logger.info(`remove from runningSessions: ${unum}`);
        runningSessions.delete(unum);
        let session = await loadUserSessionPromise(unum,logger);
        if (session.params.containerId && session.login.deviceType != "Desktop") {
            try {
                let zygotePid;
                let resps = await execDockerWaitAndroid(
                    ['exec' , session.params.containerId, 'ps', '-A', '-o' ,'PID,NAME' ]
                );
                let lines = resps.stdout.split('\n');
                for (const line of lines) {
                    let fields = line.trim().split(' ');
                    if (fields[1] == "zygote64") {
                        zygotePid = fields[0];
                        break;
                    }
                }
                if (!zygotePid) {
                    throw new Error(`zygote64 not found in pooled container`);
                }
                logger.info(`zygotePid: ${zygotePid}`);


                logger.logTime(`fastDetachUserDocker. Stop user`);

                // stop user 10
                await execDockerWaitAndroid(
                    ['exec' , session.params.containerId, 'am', 'switch-user', '0' ]
                );
                await execDockerWaitAndroid(
                    ['exec' , session.params.containerId, 'am', 'stop-user', '10' ]
                );


                if (session.params.userImageFile && session.params.tempDataDir) {
                    const syncFile = path.join(session.params.tempDataDir,'system_ce/10/accounts_ce.db');
                    logger.logTime(`fastDetachUserDocker. before sync: ${syncFile}`);
                    await execCmd('sync',["-f",syncFile]);
                    logger.logTime(`fastDetachUserDocker. after sync`);
                }

                // // unmount the data folders
                // await execDockerWaitAndroid(
                //     ['exec' , session.params.containerId, 'umount', '-l', '/data/media' ]
                // );
                // await execDockerWaitAndroid(
                //     ['exec' , session.params.containerId, 'umount', '-l', '/data' ]
                // );

                if (session.params.loopDevices) {
                    for (const loopdev of session.params.loopDevices) {
                        logger.log('info',`fastDetachUserDocker. remove loop device ${loopdev}`);
                        try {
                            await execCmd('losetup',["-d",loopdev]);
                        } catch (err) {
                            logger.info(`fastDetachUserDocker. Unable to remove loop device. err: ${err}`);
                        }
                    }
                    session.params.loopDevices = [];
                }
                // if (session.params.homeFolder && session.params.nfsHomeFolder != "local") {
                //     logger.info(`fastDetachUserDocker. unmount folder...`);
                //     try {
                //         await mount.linuxUMount(session.params.homeFolder);
                //         delete session.params.homeFolder;
                //     } catch (err) {
                //         logger.info(`fastDetachUserDocker. Unable to unmount folder. err: ${err}`);
                //     }
                // }



                if (session.params.mounts && session.params.mounts.length > 0) {
                    for (const mountedFolder of session.params.mounts) {
                        try {
                            logger.info(`fastDetachUserDocker. unmount folder: ${mountedFolder}`);
                            await mount.linuxUMount(mountedFolder);
                        } catch (err) {
                            logger.info(`fastDetachUserDocker. Unable to unmount folder. err: ${err}`);
                        }
                    }
                    session.params.mounts = [];
                }

                if (session.params.homeFolder && session.params.nfsHomeFolder != "local") {
                    logger.info(`detachUserDocker. unmount homeFolder: ${session.params.homeFolder}`);

                    try {
                        await mount.linuxUMount(session.params.homeFolder);
                        session.params.homeFolder = undefined;
                    } catch (err) {
                        logger.info(`detachUserDocker. Unable to unmount folder. err: ${err}`);
                    }
                }



                // restart zygote
                // await execDockerWaitAndroid(
                //     ['exec' , session.params.containerId, 'kill', `${zygotePid}` ]
                // );

                const lockMachine1 = new Lock("machine");
                await lockMachine1.acquire();
                try {
                    let machineConf = machineModule.getMachineConf();
                    if (machineConf.sessions && session.params.sessKey && machineConf.sessions[session.params.sessKey]) {
                        delete machineConf.sessions[session.params.sessKey];
                        delete session.params.sessKey;
                    }

                    await saveUserSessionPromise(unum, session);
                    await machineModule.saveMachineConf(machineConf);
                } finally {
                    lockMachine1.release();
                }

                waitForFullDetach = false;

            } catch (err) {
                logger.info(`fastDetachUserDocker. Error. err: ${err}`);
            }
        } else {
            logger.info(`fastDetachUserDocker. not found running android.`);
        }
    } finally {
        lockSess.release();
    }

    if (waitForFullDetach) {
        logger.info(`fastDetachUserDocker. Waiting for full detach.`);
        await detachUserDocker(unum);
    } else {
        logger.info(`fastDetachUserDocker. Continue detach in the background.`);
        safeDetachUserDocker(unum);
    }
}


async function safeDetachUserDocker(unum) {
    try {
        detachUserDocker(unum);
    } catch (err) {
        let logger = Common.getLogger(__filename);
        logger.info(`safeDetachUserDocker. error: ${err}`);
    }
}

async function detachUserDocker(unum) {
    let logger = Common.getLogger(__filename);
    logger.info(`detachUserDocker. unum: ${unum} `);
    logger.info(`remove from runningSessions: ${unum}`);
    runningSessions.delete(`u_${unum}`);
    const lockSess = new Lock(`sess_${unum}`);
    try {
        await lockSess.acquire();
        let session = await loadUserSessionPromise(unum,logger);
        //logger.info(`detachUserDocker. session loaded: ${JSON.stringify(session,null,2)}`);
        let logMeta;
        if (session.params.email) {
            logMeta= {
                user: session.params.email,
                device: session.params.deviceid,
                mtype: "important"
            }
        } else {
            logMeta = {};
        }
        const lockMachine1 = new Lock("machine");
        await lockMachine1.acquire();
        try {
            let machineConf = machineModule.getMachineConf();
            let saveMachine = false;
            if (session.params.linuxUserName) {
                delete machineConf.linuxUserName[session.params.linuxUserName];
                saveMachine = true;
            }
            if (machineConf.sessions && session.params.sessKey && machineConf.sessions[session.params.sessKey]) {
                delete machineConf.sessions[session.params.sessKey];
                saveMachine = true;
            }
            // if (machineConf.pooledSessions && machineConf.pooledSessions.indexOf(unum) >= 0 ) {
            //     let ind = machineConf.pooledSessions.indexOf(unum);
            //     machineConf.pooledSessions.splice(ind,1);
            //     saveMachine = true;
            //     logger.info(`detachUserDocker. Removed pooled session.`);
            // }
            if (saveMachine) {
                await machineModule.saveMachineConf(machineConf);
            }
        } finally {
            lockMachine1.release();
        }

        if (session.params.containerId) {
            logger.log('info',`detachUserDocker. Stopping container ${session.params.containerId}`,logMeta);
            let sesscontainer = await docker.getContainer(session.params.containerId);
            try {
                await sesscontainer.stop();
            } catch (err) {
                logger.info(`detachUserDocker. Unable to stop container. err: ${err}`);
            }
            try {
                await sesscontainer.remove();
            } catch (err) {
                logger.info(`detachUserDocker. Unable to remove container. err: ${err}`);
            }
        }
        if(session.params.volumes) {
            for(var i in session.params.volumes) {
                logger.log('info',`detachUserDocker. remove volume ${session.params.volumes[i]}`,logMeta);
                try {
                    let vol = await docker.getVolume(session.params.volumes[i]);
                    await vol.remove();
                } catch (err) {
                    logger.info(`detachUserDocker. Unable to remove volume. err: ${err}`);
                }
            }
        }
        if (session.params.loopDevices) {
            for (const loopdev of session.params.loopDevices) {
                logger.log('info',`detachUserDocker. remove loop device ${loopdev}`,logMeta);
                try {
                    await execCmd('losetup',["-d",loopdev]);
                } catch (err) {
                    logger.info(`detachUserDocker. Unable to remove loop device. err: ${err}`);
                }
            }
        }

        if (session.firewall && session.firewall.enabled && session.params.ipAddress) {
            try {
                logger.log('info',`Remove firewall rules`);
                const NUBO_USER_CHAIN = "NUBO-USER";
                let chains = await getRules(NUBO_USER_CHAIN);
                let rules = chains[NUBO_USER_CHAIN];

                // delete old rules of this ip address
                for (let i = rules.length-1; i>=0 ; i--) {
                    const rule = rules[i];
                    if (rule.source == session.params.ipAddress || rule.destination == session.params.ipAddress)  {
                        console.log(`Delete rule: ${JSON.stringify(rule)}`);
                        await deleteRule(NUBO_USER_CHAIN,rule.num);
                    }
                }
            } catch (err) {
                logger.error(`Firewall remove error: ${err}`,err);
            }
        }

        if (session.params.audioStreamParams) {
            Audio.deInitAudio(unum);
            // remove apks folder
            // const apksDir = path.resolve(`./sessions/apks_${unum}`);
            // fsp.rm(apksDir,{ recursive: true, force: true });
            // const dataDir = path.resolve(`./sessions/data_${unum}`);
            // await execCmd('/usr/bin/umount',[dataDir]);
            // await fsp.rmdir(dataDir);
        }
        if (session.params.homeFolder && session.params.nfsHomeFolder != "local") {
            logger.info(`detachUserDocker. unmount folder...`);
            try {
                await mount.linuxUMount(session.params.homeFolder);
            } catch (err) {
                logger.info(`detachUserDocker. Unable to unmount folder. err: ${err}`);
            }
        }

        if (session.params.mounts && session.params.mounts.length > 0) {
            for (const mountedFolder of session.params.mounts) {
                try {
                    logger.info(`detachUserDocker. unmount folder: ${mountedFolder}`);
                    await mount.linuxUMount(mountedFolder);
                } catch (err) {
                    logger.info(`detachUserDocker. Unable to unmount folder. err: ${err}`);
                }
            }
        }
        // if (session.params.mountedStorageFolder) {
        //     logger.info(`detachUserDocker. unmount storage folder...`);
        //     try {
        //         await mount.linuxUMount(session.params.mountedStorageFolder);
        //     } catch (err) {
        //         logger.info(`detachUserDocker. Unable to unmount folder. err: ${err}`);
        //     }
        // }


        if (session.params.sessPath) {
            logger.info(`detachUserDocker. remove session folder...`);
            try {
                await fsp.rm(session.params.sessPath,{recursive: true});
            } catch (err) {
                logger.info(`detachUserDocker. Unable to unmount folder. err: ${err}`);
            }
        }


        await deleteSessionPromise(unum);

        logger.log('info',`detachUserDocker. User removed.`,logMeta);
        return true;
    } finally {
        lockSess.release();
    }
}


function getLinuxUserName(email,unum,machineConf) {
    let nameParts = email.split("@");
    let basename = nameParts.length==2 ? nameParts[0] : email;
    let cnt=0;
    if (!machineConf.linuxUserName) {
        machineConf.linuxUserName = {
        }
    }
    let name = basename;
    while (machineConf.linuxUserName[name]) {
        cnt++;
        name = basename+cnt;
    }
    machineConf.linuxUserName[name] = unum;
    return name;
}


function attachUser(req, res) {
    var resDone = false;
    var logger = new ThreadedLogger(Common.getLogger(__filename));
    var unum = 0;
    var obj = req.body;
    logger.logTime("Start process request attachUser. isDockerPlatform: "+machineModule.isDockerPlatform());
    if (machineModule.isDockerPlatform()) {
        attachUserDocker(obj,logger).then((result) => {
            var resobj = {
                status: 1,
                localid: result.unum,
                params: result
            };
            res.end(JSON.stringify(resobj,null,2));
            logger.logTime("Finish process request attachUser");
        }).catch(err => {
            logger.info(`Error on attachUserDocker: ${err}`);
            console.error(err);
            var resobj = {
                status: 0,
                error: err
            };
            res.end(JSON.stringify(resobj,null,2));
        });
        return;
    }

    async.waterfall(
        [
            //create workable android user
            function (callback) {
                console.log("reqestObj: ", obj);
                createUser(obj, logger, callback);
            },
            //response to request on success
            function (session, callback) {
                unum = session.params.localid;
                var resobj = {
                    status: 1,
                    localid: unum
                };
                resDone = true;
                res.end(JSON.stringify(resobj,null,2));
                callback(null, session);
            },
            //post create processes (attach applications, etc)
            function (session, callback) {
                callback(null);
            }
        ], function (err) {
            if(err) {
                if(!resDone) {
                    var resobj = {
                        status: 0,
                        error: err
                    };
                    res.end(JSON.stringify(resobj,null,2));
                }
                logger.error("request finished with error: " + err);
            }
            logger.logTime("Finish process request attachUser");
        }
    );
}

function detachUser(req, res) {
    var unum = req.params.unum;
    var logger = new ThreadedLogger(Common.getLogger(__filename));
    logger.logTime("Start process request detachUser");
    var platform = new Platform(logger);
    var resobj;
    if(isNaN(unum) || (unum <= 0)) {   // is unum does not greater that 0 mean check if unum is number too
        resobj = {status: 0, message: "invalid unum, unum is " + unum};
        res.end(JSON.stringify(resobj,null,2));
        return;
    }
    if (machineModule.isDockerPlatform()) {
        fastDetachUserDocker(unum).then((result) => {
            var resobj = {
                status: 1,
                message: "User " + unum + " removed"
            };
            res.end(JSON.stringify(resobj,null,2));
            logger.logTime("Finish process request detachUser");
        }).catch(err => {
            var resobj = {
                status: 0,
                error: err
            };
            res.end(JSON.stringify(resobj,null,2));
            logger.logTime("Finish process request detachUser");
        });
        return;
    } else {
        endSessionByUnum(unum, logger, function (err) {
            if(err) {
                resobj = {status: 0, error: err};
            } else {
                resobj = {status: 1, message: "User " + unum + " removed"};
            }
            res.end(JSON.stringify(resobj,null,2));
            logger.logTime("Finish process request detachUser");
        });
    }

}



var sessCache = {};

function saveUserSessionPromise(localid,session) {
    return new Promise((resolve,reject) => {
        saveUserSessionParams(localid,session,function(err){
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        })
    });
}
function loadUserSessionPromise(localid,logger) {
    return new Promise((resolve,reject) => {
        loadUserSessionParams(localid,logger,function(err,session){
            if (err) {
                reject(err);
            } else {
                resolve(session);
            }
        })
    });
}

function deleteSessionPromise(localid) {
    return new Promise((resolve,reject) => {
        deleteSessionParams(localid,function(err){
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        })
    });
}


function saveUserSessionParams(localid,session,cb) {
    sessCache['sess_'+localid] = session;
    let fileName = "./sessions/localid_"+localid+".json";
    let sessStr = JSON.stringify(session,null,2);
    fs.writeFile(fileName,sessStr,function(err){
        cb(err);
    });
}

function loadUserSessionParams(localid,logger,cb) {
    let session = sessCache['sess_'+localid];
    if (session) {
        cb(null,session);
        return;
    }
    let fileName = "./sessions/localid_"+localid+".json";
    fs.readFile(fileName,'utf8',function(err, data){
        if (err) {
            logger.error("Error read session file: "+err);
            console.error(err);
            cb(err,null);
            return;
        }
        try {
            session = JSON.parse(data);
            cb(null,session);
        } catch(err) {
            logger.error("Error parsing session file: "+err);
            console.error(err);
            cb(err,null);
        }
    });
}

function deleteSessionParams(localid,cb) {
    sessCache['sess_'+localid] = null;
    let fileName = "./sessions/localid_"+localid+".json";
    fs.unlink(fileName,function(err){
        if (cb) {
            cb(err);
        }
    });
}

function createUser(obj, logger, callback) {
    var timeZone = obj.timeZone;
    var localid = 0;
    var platform = new Platform(logger);
    var session = {
        login: obj.login,
        platform: platform,
        logger: logger,
        nfs: obj.nfs,
        mounts: obj.mounts,
        xml_file_content: obj.xml_file_content
    };
    var addToErrorsPlatforms = false;
    var platformErrorFlag = false;


    function debugCheckConfFile(step, cb) {
        let fileName = "/Android/data/system/users/" + localid + "/package-restrictions.xml";
        fs.readFile(fileName, 'utf8', function (err, data) {
            if (err) {
                logger.error("Error read package-restrictions.xml file: " + err);
                console.error(err);
                cb(null);
                return;
            }
            if ( data.indexOf("pkg name=\"amirz.rootless.nexuslauncher\" inst=\"false\"") >= 0 ) {
                logger.error("debugCheckConfFile. package-restrictions.xml changed! step: "+step+", file: "+data);
            } else {
                logger.info("debugCheckConfFile. package-restrictions.xml is ok. step: "+step);
            }
            cb(null);

        });

    }

    function createSessionFiles(session, callback) {
        if (!session.xml_file_content || session.xml_file_content.length == 0) {
		callback(null);
		return;
	}
        let xml_file = "/Android/data/user/" + localid+"/Session.xml"
        fs.writeFile(xml_file, session.xml_file_content, function(err) {
            if (err) {
                var msg = "Failed to create Session.xml file. error: " + err;
                logger.error(msg);
                callback(msg);
            } else {
                fs.chmod(xml_file, '600', function(err) {
                    var msg = null;
                    if (err) {
                        msg = "Failed to chmod Session.xml file. error: " + err;
                    }
                    fs.chown(xml_file, 1000, 1000, function(err) {
                        if (err) {
                            msg = msg + "Failed to chown Session.xml file. error: " + err;
                        }
                        callback(msg);
                    });
                });
            }
        });
    }

    /*
     * Create startup.json, Session.xml, sessionid
     */
    //function createSessionFiles(session, callback) {
    //    var login = session.login;
    //    async.series([
    //            // Handle certificate if one exists
    //            function (callback) {
    //                var domain = login.mainDomain;
    //                var email = login.userName;
    //                User.handleCertificatesForUser(domain, email, deviceID, callback);
    //            },
    //            function (callback) {
    //                //create imServerParams file
    //                User.saveIMSettingsFile(session.email, login.imUserName, deviceID, localid, function (err) {
    //                    if(err) {
    //                        logger.error("Error saveIMSettingsFile : " + err);
    //                    }
    //                    callback(null);
    //                });
    //            },
    //            function (callback) {
    //                //create Session.xml
    //                var rootFolder = Common.nfshomefolder;
    //                var xml_file = rootFolder + User.getUserDeviceDataFolder(UserName, deviceID) + "Session.xml";
    //                logger.info("rootFolder: " + rootFolder + ", xml_file: " + xml_file);
    //                var xml_file_content = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\r\n" +
    //                    "<session>\r\n" +
    //                    "\t<gateway_url>" + session.params.gatewayInternal + "</gateway_url>\r\n" +
    //                    "\t<gateway_controller_port>" + session.params.gatewayControllerPort + "</gateway_controller_port>\r\n" +
    //                    "\t<gateway_apps_port>" + session.params.gatewayAppsPort + "</gateway_apps_port>\r\n" +
    //                    "\t<platformID>" + platform.params.platid + "</platformID>\r\n" +
    //                    "\t<management_url>" + Common.serverurl + "</management_url>\r\n" +
    //                    "\t<username>" + login.loginParams.userName + "</username>\r\n" +
    //                    "</session>\r\n";
    //                createFile(xml_file, xml_file_content, '600', 1000, 1000, function (err) {
    //                    callback(err);
    //                });
    //            },
    //            function (callback) {
    //                var rootFolder = Common.nfshomefolder;
    //                var sess_file = rootFolder + User.getUserDeviceDataFolder(UserName, deviceID) + "sessionid";
    //                //logger.info("rootFolder: "+rootFolder+", sess_file: "+sess_file);
    //                var sess_file_content = session.params.sessid;
    //                createFile(sess_file, sess_file_content, '644', 1000, 1000, function (err) {
    //                    callback(err);
    //                });
    //            }
    //        ], function (err) {
    //            //logger.info("Session.xml and sessionid created succesfully");
    //            if(err) {
    //                logger.info("Error: Cannot create session description files");
    //            }
    //            callback(err);
    //        }
    //    );
    //}

    /**
     * Run am create-user on the platform
     */

    function amCreateUser(platform, session, callback) {
        platform.execFile("am", ["create-user", localid], function (err) {
            if(err) {
                var msg = "Error in adb shell: " + err;
                platformErrorFlag = true;
                callback(msg);
                return;
            }
            callback(null);
        });
    }

    /*
     * create android user, chech his number, empty directories
     * Arguments:
     *  callback(err, localid)
     *  err - error message, if exist
     *  localid - number of created user
     */
    function createUserAndroid(callback) {
        var localid;
        async.series([
                // create user
                function (callback) {
                    platform.execFile("pm", ["create-user", session.params.email + session.params.deviceid], function (err, stdout, stderr) {
                        if(err) {
                            addToErrorsPlatforms = true;
                            var msg = "Error in adb shell: " + err;
                            platformErrorFlag = true;
                            callback(msg);
                            return;
                        }
                        var re = new RegExp('Success: created user id ([0-9]+)');
                        var m = re.exec(stdout);
                        if(m) {
                            localid = m[1];
                            logger.logTime("pm create-user");
                            callback(null);
                        } else {
                            callback("Error with PM - cannot get localid");
                        }
                    });
                }, //function(callback)
                function (callback) {
                    execFile("rm", ["-rf", "/Android/data/user/" + localid], function (err) {callback(err);});
                },
                function (callback) {
                    execFile("rm", ["-rf", "/Android/data/user_de/" + localid], function (err) {callback(err);});
                },
                function (callback) {
                    fs.mkdir("/Android/data/user/" + localid, function (err) {callback(err);});
                },
                function (callback) {
                    fs.mkdir("/Android/data/user_de/" + localid, function (err) {callback(err);});
                },
                //function (callback) {
                //    fs.chown("/Android/data/user/" + localid, 1000, 1000, function (err) {callback(err);});
                //},
                //function (callback) {
                //    fs.fchmod("/Android/data/user/" + localid, 0o771, function (err) {callback(err);});
                //},
                function (callback) {
                    fs.mkdir("/Android/data/system/users/" + localid, function (err) {callback(null);});
                },
                //function (callback) {
                //    fs.chown("/Android/data/system/users/" + localid, 1000, 1000, function (err) {callback(err);});
                //},
                //function (callback) {
                //    fs.fchmod("/Android/data/system/users/" + localid, 0o700, function (err) {callback(err);});
                //},
                function (callback) {
                    execFile("sync", [], function (err) {callback(err);});
                },
                function (callback) {
                    execFile("rm", ["-rf", "/Android/data/misc/keystore/user_" + localid + '/*'], function (err) {callback(err);});
                }
            ], function (err) {
                if(err) {
                    logger.info("Error: cannot initializate android user err:" + err);
                }
                callback(err, localid);
            }
        );
    }

// End of definitions

    /*
     * Start of code
     */
    async.series([
        function (callback) {
            session.params = {
                email: obj.session.email,
                deviceid: obj.session.deviceid,
                appName: obj.session.appName
            };
            callback(null);
        },
        // create user
        function (callback) {
            createUserAndroid(function (err, res) {
                var val = validate.single(localid, {numericality: {onlyInteger: true}});
                if (val) {
                    err = "Error creating user";
                }

                if(!err) localid = res;
                callback(err);
            });
        },
        function (cb) {
            session.params.localid = localid;
            saveUserSessionParams(localid,session,cb);
        },
        // create session files
//            function(callback) {
//                createSessionFiles(platform, session, function(err) {
//                    logger.logTime("createSessionFiles");
//                    callback(err);
//                });
//            },
        // mount all nfs folders
        function (callback) {
            mount.fullMount(session, null, function (err) {
                if(err) logger.error("Cannot mount user's directories");
                logger.logTime("fullMount");
                callback(err);
            });
        },
        function(callback) {
            createSessionFiles(session,callback);
        },
        function (callback) {
            Audio.initAudio(localid, function (err) {
                logger.logTime("initAudio");
                if (err) {
                    logger.info("initAudio error: "+err);
                }
            });
            // do not wait to init audio to finish before finish attach session
            callback(null);
        },
        function (callback) {
            refreshPackages(session, function (err) {
                logger.logTime("refreshPackages");
                callback(err);
            });
        },
        function (callback) {
            setPerUserEnvironments(session, timeZone, callback);
        },
        function (callback) {
            amCreateUser(platform, session, function (err) {
                logger.logTime("amCreateUser");
                callback(err);
            });
        }
    ], function (err, results) {
        if(err) {
            logger.info("Error during session create: " + err);
            endSessionByUnum(localid, logger, function (error) {
                callback(err);
            });
        } else {
            logger.info("User attached successfully");
            callback(null, session);
        }
    });
    return;
}

function setPerUserEnvironments(session, timeZone, callback) {
    var login = session.login;
    var email = login.userName;
    var localid = session.params.localid;
    var lang = login.lang;
    var countrylang = login.countrylang;
    var localevar = login.localevar;
    var appName = (session.params.appName ? session.params.appName : "Nubo");

    async.series(
        [
            function(callback) {
                session.platform.execFile("setprop", ["nubo.language.u" + localid, lang], function() {callback(null);});
            },
            function(callback) {
                session.platform.execFile("setprop", ["nubo.country.u" + localid, countrylang], function() {callback(null);});
            },
            function(callback) {
                session.platform.execFile("setprop", ["nubo.localevar.u" + localid, localevar], function() {callback(null);});
            },
            function(callback) {
                session.platform.execFile("setprop", ["nubo.appname.u" + localid, appName], function() {callback(null);});
            },
            function(callback) {
                if(timeZone !== null && timeZone !== "") {
                    session.platform.execFile("setprop", ["nubo.timezone.u" + localid, timeZone], function() {callback(null);});
                } else {
                    session.logger.error("ERROR: missing timeZone param.");
                    callback(null);
                }
            }/*,
            function(callback) {
                session.platform.execFile("getprop", [], function() {callback(null);});
            }*/
        ], function(err) {
        callback(null);
        }
    );
}

function removePerUserEnvironments(localid,platform,logger,cb) {
    logger.info("removePerUserEnvironments. localid: "+localid);
    async.series(
        [
            function(callback) {
                platform.execFile("setprop", ["nubo.language.u" + localid, ""], function() {callback(null);});
            },
            function(callback) {
                platform.execFile("setprop", ["nubo.country.u" + localid, ""], function() {callback(null);});
            },
            function(callback) {
                platform.execFile("setprop", ["nubo.localevar.u" + localid, ""], function() {callback(null);});
            },
            function(callback) {
                platform.execFile("setprop", ["nubo.locale.u" + localid, ""], function() {callback(null);});
            },
            function(callback) {
                platform.execFile("setprop", ["nubo.timezone.u" + localid, ""], function() {callback(null);});
            },
            function(callback) {
                platform.execFile("setprop", ["nubo.appname.u" + localid, ""], function() {callback(null);});
            }
        ], function(err) {
            if (cb) {
                logger.info("removePerUserEnvironments. finished. localid: "+localid);
                cb(err);
            };
        }
    );
}

function refreshPackages(session, callback) {
    var localid = session.params.localid;
    var platform = session.platform;
    var deviceType = session.login.deviceType;

    async.series(
        [
            function (callback) {
                platform.execFile("pm", ["refresh", localid], function(err) {callback(null);});
            },
//            function (callback) {
//                platform.execFile("pm", ["disable", "--user", localid, "com.android.vending"], function(err) {callback(null);});
//            },
            function (callback) {
                platform.execFile("pm", ["grant", "--user", localid,"com.google.android.gms","android.permission.ACCESS_FINE_LOCATION"], function (err) { callback(null); });
            },
            function (callback) {
                if(deviceType === 'Web') {
                    platform.execFile("pm", ["disable", "--user", localid, "com.android.browser"], function(err) {callback(null);});
                } else {
                    callback(null);
                }
            },
            function (callback) {
                if(deviceType === 'Web') {
                    platform.execFile("pm", ["enable", "--user", localid, "com.android.inputmethod.latin"], function(err) {callback(null);});
                } else {
                    callback(null);
                }
            }
        ], function(err) {
            callback(err);
        }
    );
}

// This function should been called after session and platform locked
// session can been null, platform can been null
function endSessionByUnum(unum, logger, callback) {
    var platform = new Platform(logger);
    var sessLogger = logger;
    var session;
    async.series(
        [
            function (callback) {
                if(unum === 0) {
                    callback("no UNum");
                } else {
                    async.series(
                        [
                            function(callback) {
                                loadUserSessionParams(unum,logger,function(err,sessObj){
                                    session = sessObj;
                                    if (!session) {
                                        session = {
                                            params: {
                                                localid: unum
                                            }
                                        };
                                    }
                                    callback();
                                });
                            },
                            // Logout. pm remove-user close all user's applications
                            function (callback) {
                                platform.execFile("pm", ["remove-user", unum.toString()], function (err, stdout, stderr) {
                                    sessLogger.logTime("pm remove-user");
                                    callback(null);
                                    // Try to continue even if pm failed
                                });
                                // platform.exec
                            },
                            function (callback) {
                                Audio.deInitAudio(unum, function (err) {
                                    logger.logTime("deInitAudio");
                                    if (err) {
                                        logger.info("deInitAudio error: "+err);
                                    }
                                });
                                // do not wait to deinit audio to finish
                                callback(null);
                            },
                            // force close all user's applications if it still exist
                            function (callback) {
                                closeUserProcesses(unum,logger,callback);
                            }, // function(callback)
                            // unmount folders
                            function (callback) {
                                session.platform = platform;
                                mount.fullUmount(session, null, function (err) {
                                    if(err) {
                                        logger.info("ERROR: cannot umount user's directories, err:" + err);
                                        callback(err);
                                    } else {
                                        callback(null);
                                    }
                                });
                            }, // function(callback)
                            function (callback) {
                                removeNonMountedDirs(unum,logger,callback);
                            },
                            function (callback) {
                                removeMountedDirs(unum,logger,callback);
                            },
                            function (callback) {
                                removePerUserEnvironments(unum, platform,logger,callback);
                            },
                            function (callback) {
                                deleteSessionParams(unum,function(err) {
                                    if (err) {
                                        logger.error("Error in deleteSessionParams",err)
                                    }
                                    callback();
                                });
                            }
                        ], function (err, results) {
                            callback(err);
                        }
                    );
                }
            }
        ], function (err, results) {
            if(err) {
                logger.error("Error during user detach: " + err);
            }
            callback(err);
        }
    );
}

function closeUserProcesses(unum,logger,callback) {
    const maxWaitTime = 30;
    const waitForIteration = 2;
    let timePassed = 0;
    let userProcs = null;
    async.doWhilst(function(callback) {
        execFile("ps", ["auxn"], function (err, stdout, stderr) {
            if(err) {
                logger.info(`ps error: ${err}`);
                callback(err);
                return;
            }
            var lines = stdout.split("\n");
            var procs = _.map(lines, function(line) {
                var fields = line.split(/[ ]+/);
                var procObj = {
                    uid: fields[1] || "",
                    pid: fields[2] || "",
                    name: fields[11] || ""
                };
                return procObj;
            });
            var userTest = new RegExp("^" + unum.toString() + "[0-9]{5}$");
            userProcs = _.filter(procs, function(procObj) {return (userTest.test(procObj.uid));});
            if (userProcs.length !== 0) {
                logger.info(`closeUserProcesses Remaining processes: ${JSON.stringify(userProcs,null,2)}`);
            } else {
                logger.info(`closeUserProcesses all user processes closed. time: ${timePassed}`);
            }
            timePassed += waitForIteration;
            if (userProcs.length !== 0 && timePassed < maxWaitTime) {
                setTimeout(function(){
                    callback(null);
                },waitForIteration * 1000);
            } else {
                callback(null);
            }
        });
    }, function() {
        return (userProcs.length !== 0 && timePassed < maxWaitTime);
    }, function(err){
        if (err) {
            logger.info("closeUserProcesses failed with error: "+err);
        } else {
            if (userProcs.length !== 0) {
                logger.info(`closeUserProcesses failed after waiting ${timePassed} seconds. Killing remaining processes...`);
                // kill processes
                async.eachSeries(userProcs,function(process,cb) {
                    ps.kill(process.pid, 'SIGKILL', function(err) {
                        if (err) {
                            logger.error("Unable to kill pid "+process.pid+", kill error: ", err);
                        } else {
                            logger.info("pid "+process.pid+" has been killed.");
                        }
                        cb();
                    });
                },function(err) {
                    logger.info("Finished processes kill for user "+unum);
                });
            } else {
                logger.info(`closeUserProcesses finished sucessfully.`);
            }
        }
        callback(null);
    });

}

function checkDir(step,dir, logger, callback) {
    execFile("ls", ["-la",dir], function (err,stdout,stderr) {
        logger.info(`${step}. ls -la ${dir}: ${stdout}`);
        callback(null);
    });
}

function removeDirIfEmptyEx(dir, logger, callback) {
    execFile("ls", ["-la",dir], function (err,stdout,stderr) {
        logger.info(`removeDirIfEmptyEx. ls -la. : ${stdout}`);
        fs.rmdir(dir, function (err) {
            if (err) {
                logger.error("rmdir error: "+err);
            } else {
                logger.info("Removed empty dir: "+dir);
            }
            callback(null);
        });
    });
}


function removeMountedDirs(UNum,logger, callback) {
    const mountedDirs = [
        "/Android/data/misc/keystore/user_" + UNum,
        "/Android/data/misc_ce/" + UNum,
        "/Android/data/misc_de/" + UNum,
        "/Android/data/system/users/" + UNum,
        "/Android/data/system_ce/" + UNum,
        "/Android/data/system_de/" + UNum,
        "/Android/data/user/" + UNum,
        "/Android/data/user_de/" + UNum,
        "/Android/data/media/" + UNum,
        "/Android/data/mnt/nfs/" + UNum
    ];
    async.eachSeries(
        mountedDirs,
        function(dir, callback) {
            removeDirIfEmpty(dir,logger,callback)
        },
        function(err) {
            callback();
        });
}

function removeDirIfEmpty(dir, logger, callback) {
    fs.rmdir(dir, function (err) {
        if (err) {
            logger.error(`removeDirIfEmpty error: ${err}, dir: ${dir}`);
        } else {
            //logger.info("Removed empty dir: "+dir);
        }
        callback(null);
    });
}

function removeNonMountedDirs(UNum,logger, callback) {
    const dirs = [
        `/Android/data/misc/profiles/cur/${UNum}`,
        `/Android/data/misc/gatekeeper/${UNum}`,
        `/Android/data/misc/user/${UNum}`,
        `/Android/data/system/users/${UNum}/settings_system.xml`,
        `/Android/data/system/users/${UNum}/settings_secure.xml`,
        `/Android/data/system/users/${UNum}.xml`
    ];
    async.eachSeries(
        dirs,
        function(dir, callback) {
            fs.rm(dir,{
                force: true,
                maxRetries: 100,
                recursive: true,
                retryDelay: 100
            },function(err) {
                if (err) {
                    logger.error(`removeNonMountedDirs error: ${err}, dir: ${dir}`);
                }
                callback();
            });
        },
        function(err) {
            callback();
        });
}



//function createFile(file, data, permissions, uid, gid, callback) {
//    async.series(
//        [
//            function (callback) {
//                fs.writeFile(file, data, function (err) {
//                    callback(err);
//                });
//            },
//            function (callback) {
//                fs.chmod(file, permissions, function (err) {
//                    callback(err);
//                });
//            },
//            function (callback) {
//                fs.chown(file, uid, gid, function (err) {
//                    callback(err);
//                });
//            }
//        ], function (err) {
//            callback(err);
//        }
//    );
//}

function receiveSMS(req, res) {
    var params = req.body;
    var unum = params.localid;
    var to = params.to;
    var from = params.from;
    var text = params.text;
    var pdu = params.pdu;
    var logger = new ThreadedLogger(Common.getLogger(__filename));
    logger.logTime("Start process request receiveSMS");
    var platform = new Platform(logger);
    var resobj;
    if (!to || !from || !text) {
        resobj = {status: 0, message: "invalid parameters" };
        logger.info("invalid parameters. to: "+to+", from: "+from+", text: "+text);
        res.end(JSON.stringify(resobj,null,2));
        return;
    }

    if(isNaN(unum) || (unum <= 0)) {   // is unum does not greater that 0 mean check if unum is number too
        resobj = {status: 0, message: "invalid unum, unum is " + unum};
        res.end(JSON.stringify(resobj,null,2));
        return;
    }
    var args = ["broadcast", "--user", unum, "-a", "android.intent.action.DATA_SMS_RECEIVED",
        "--es", "nubo_sms_to",to,
        "--es", "nubo_sms_from",from,
        "--es", "nubo_sms_text",text,
        "--es", "nubo_sms_pdu",pdu ];
    logger.info("Command: am "+args);
    platform.execFile("am", args, function(err, stdout, stderr) {
        if(err) {
            resobj = {status: 0, error: err};
        } else {
            resobj = {status: 1, message: "Message send to user."};
        }
        logger.info("err: "+err+", stdout: "+stdout+", stderr: "+stderr);
        res.end(JSON.stringify(resobj,null,2));
        logger.logTime("Finish process request receiveSMS");
    });
}

function declineCall(req, res) {
    var params = req.body;
    var unum = params.localid;

    var logger = new ThreadedLogger(Common.getLogger(__filename));
    logger.logTime("Start process request declineCall");
    var platform = new Platform(logger);
    var resobj;

    if(isNaN(unum) || (unum <= 0)) {   // is unum does not greater that 0 mean check if unum is number too
        resobj = {status: 0, message: "invalid unum, unum is " + unum};
        res.end(JSON.stringify(resobj,null,2));
        return;
    }
    var args = ["broadcast", "--user", unum, "-a", "com.nubo.sip.DECLINE_INCOMING_CALL" ];
    logger.info("Command: am "+args);
    platform.execFile("am", args, function(err, stdout, stderr) {
        if(err) {
            resobj = {status: 0, error: err};
        } else {
            resobj = {status: 1, message: "Message send to user."};
        }
        logger.info("err: "+err+", stdout: "+stdout+", stderr: "+stderr);
        res.end(JSON.stringify(resobj,null,2));
        logger.logTime("Finish process request declineCall");
    });




}

