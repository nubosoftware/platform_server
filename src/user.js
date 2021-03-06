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



module.exports = {
    attachUser: attachUser,
    detachUser: detachUser,
    //for tests
    createUser: createUser,
    endSessionByUnum: endSessionByUnum,
    receiveSMS: receiveSMS,
    declineCall: declineCall,
    loadUserSessionPromise,
    detachUserDocker,
    createPooledSession
};

let lastCreateSessionTime = 0;
const MIN_CREATE_POOL_SESSION_WAIT_MS = 1000 * 60 * 2; // wait two minutes after create session before create pooled sessions

async function createPooledSession() {
    let logger = Common.getLogger(__filename);
    let now = new Date().getTime();
    let createDiff = now - lastCreateSessionTime;
    if (createDiff < MIN_CREATE_POOL_SESSION_WAIT_MS) {
        logger.info(`createPooledSession. too early to start pooled session after ${(createDiff/1000)} seconds.`);
        return;
    }
    let machineConf = machineModule.getMachineConf();
    // get new unum
    let unum = machineConf.unumCnt;
    if (isNaN(unum) || unum == 0) {
        unum = 10;
    }
    machineConf.unumCnt = unum + 1;
    await machineModule.saveMachineConf(machineConf);
    const registryURL = machineConf.registryURL;
    let session = {
        params: {
            localid: unum
        },
        login: {
            deviceType: "pool"
        }
    };

    try {
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
        session.params.sessPath = sessPath;
        session.params.apksPath = apksPath;

        logger.info(`Create local data volume for temp session`);
        const imgFilePath = path.join(sessPath,'temp_data.img'); //path.resolve(`./sessions/temp_data_${unum}.img`);
        const skelFile = path.resolve(`./docker_run/skel.img`);
        await fsp.copyFile(skelFile,imgFilePath);

        let losetupres =  await execCmd('losetup',["-f",imgFilePath,"--show"]);
        let loopDeviceNum = losetupres.stdout.trim();
        session.params.loopDevices = [loopDeviceNum];


        let vol_data = await docker.createVolume({
            Name: "nubo_" + session.params.localid + "_temp_data",
            DriverOpts : {
                device: loopDeviceNum,
                type: "ext4"
            }
        });
        // session.params.loopDevices = [loopDeviceNum];
        session.params.volumes = [vol_data.name];

        await saveUserSessionPromise(unum, session);

        // get user image from registry
        let imageName = `${registryURL}/nubo/nubo-android-10`;
        logger.info(`Pulling user image: ${imageName}`);
        await pullImage(imageName);

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
                '-v',`${vol_data.name}:/data`,
                '-v',`${externalSessPath}:/nubo:rw,rshared`,
        ];
        let cmdArgs = ['/init'];
        let args = startArgs.concat(mountArgs, imageName, cmdArgs);
        await saveUserSessionPromise(unum, session);
        console.log("start docker args: ", args);
        const runRes = await execDockerCmd(
            args,{cwd: dockerRunDir}
        );

        const containerID = runRes.stdout.trim();

        session.params.containerId = containerID;
        await saveUserSessionPromise(unum, session);

        // wait for launcher to start
        let started = false;
        let cnt = 0;
        let system_server = "system_server";

        logger.info(`Waiting for system_server to start..`);
        while (!started && cnt < 200) {
            cnt++;
            let resps = await execDockerWaitAndroid(
                ['exec' , containerID, 'ps', '-A' ]
            );
            if (resps.stdout && resps.stdout.indexOf(system_server) >= 0) {
                started = true;
            } else {
                sleep(500);
            }
        }
        if (!machineConf.pooledSessions) {
            machineConf.pooledSessions = [];
        }
        machineConf.pooledSessions.push(unum);
        await machineModule.saveMachineConf(machineConf);



        logger.info(`Pooled session created on platform. unum: ${unum}, containerID: ${containerID}`);
    } catch (err) {
        logger.error(`createPooledSession. Error: ${err}`,err);
        try {
            await saveUserSessionPromise(unum,session);
            await detachUserDocker(unum);
        } catch (e2) {
            logger.error(`createPooledSession. detachUserDocker failed: ${e2}`,e2);
        }
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
        platformSettings: obj.platformSettings
        //xml_file_content: obj.xml_file_content
    };
    let machineConf = machineModule.getMachineConf();

    let unum;
    if (session.login.deviceType != "Desktop" && machineConf.pooledSessions && machineConf.pooledSessions.length > 0) {
        unum =  machineConf.pooledSessions.shift();
        logger.info(`attachUserDocker. Using pooled session. unum: ${unum}`);
        let pooledSession = await loadUserSessionPromise(unum,logger);
        _.extend(session.params, pooledSession.params);
        session.params.pooledSession = true;
        logger.info(`attachUserDocker. merged session object: ${JSON.stringify(session,null,2)}`);
    } else {
        // get new unum
        unum = machineConf.unumCnt;
        if (isNaN(unum) || unum == 0) {
        unum = 10;
        }
        machineConf.unumCnt = unum + 1;
    }
    const linuxUserName = getLinuxUserName(obj.login.email,unum,machineConf);

    result.unum = unum;
    const registryURL = machineConf.registryURL;


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
    await machineModule.saveMachineConf(machineConf);
    try {
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

            // mount user folder
            logger.log('info', "Mount user home folder");
            await mount.mobileMount(session);
            logger.logTime(`User home folder mounted at ${session.params.homeFolder}`);


            // mount data.img as loop device
            const imgFilePath = path.join(session.params.homeFolder,'data.img');

            // const dataDir = path.resolve(`./sessions/data_${unum}`);
            // await fsp.mkdir(dataDir,{recursive: true});
            // await execCmd('/usr/bin/mount',[imgFilePath, dataDir]);
            let losetupres =  await execCmd('losetup',["-f",imgFilePath,"--show"]);
            let loopDeviceNum = losetupres.stdout.trim();
            if (!session.params.loopDevices) {
                session.params.loopDevices = [];
            }
            session.params.loopDevices.push(loopDeviceNum);

            if (session.params.pooledSession) {
                let stats = await fsp.stat(loopDeviceNum);
                let major = (stats.rdev >> 8 );
                let minor = (stats.rdev & 0xFF );
                await saveUserSessionPromise(unum, session);
                // let zygotePid;
                // let resps = await execDockerWaitAndroid(
                //     ['exec' , session.params.containerId, 'ps', '-A', '-o' ,'PID,NAME' ]
                // );
                // let lines = resps.stdout.split('\n');
                // for (const line of lines) {
                //     let fields = line.trim().split(' ');
                //     if (fields[1] == "zygote64") {
                //         zygotePid = fields[0];
                //         break;
                //     }
                // }
                // if (!zygotePid) {
                //     throw new Error(`zygote64 not found in pooled container`);
                // }
                // logger.logTime(`zygotePid: ${zygotePid}`);

                if (!session.params.mounts) {
                    session.params.mounts = [];
                }
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
                logger.logTime(`Create swap user in container ${session.params.containerId}, mount loop device (${major} ${minor}), and restart zygote64 `);

                // // create a file for the loop device
                // await execDockerWaitAndroid(
                //     ['exec' , session.params.containerId, 'mknod', '/dev/d.img', 'b' , `${major}` , `${minor}` ]
                // );

                // // unmount the temp /data folder
                // await execDockerWaitAndroid(
                //     ['exec' , session.params.containerId, 'umount', '-l', '/data' ]
                // );

                // // mount the new data folder
                // await execDockerWaitAndroid(
                //     ['exec' , session.params.containerId, 'mount', '/dev/d.img', '/data' ]
                // );

                // // mount the sdcard
                // try {
                //     await execDockerWaitAndroid(
                //         ['exec' , session.params.containerId, 'mount', '--bind', '/nubo/storage', '/data/media' ]
                //     );
                // } catch (err) {
                //     logger.info(`Error mount /data/media: ${err}`);
                // }

                // // restart zygote
                // await execDockerWaitAndroid(
                //     ['exec' , session.params.containerId, 'kill', `${zygotePid}` ]
                // );

                // run login script
                await execDockerWaitAndroid(
                    ['exec' , session.params.containerId, 'sh', '-e' , '/system/etc/login_user.sh' , `${major}` , `${minor}`  ]
                );


                logger.logTime(`After restart zygote`);

                if(session.params.audioStreamParams) {
                    await Audio.initAudio(unum);
                }

            } else {

                logger.log('info', `Create local volume for ${loopDeviceNum}`);

                let vol_data = await docker.createVolume({
                    Name: "nubo_" + session.params.localid + "_data",
                    DriverOpts : {
                        device: loopDeviceNum,
                        type: "ext4"
                    }
                });

                session.params.volumes = [vol_data.name];
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
                session.params.sessPath = sessPath;
                session.params.apksPath = apksPath;

                await saveUserSessionPromise(unum, session);
                if(session.params.audioStreamParams) {
                    await Audio.initAudio(unum);
                }

                // get user image from registry
                let imageName = `${registryURL}/nubo/${session.params.docker_image}`;
                logger.log('info', `Pulling user image: ${imageName}`, logMeta);
                await pullImage(imageName);

                // creating container
                const dockerRunDir = path.resolve("./docker_run");
                // const apksDir = path.resolve(`./sessions/apks_${unum}`);
                // await fsp.mkdir(apksDir,{recursive: true});
                logger.info(`Creating session container. dockerRunDir: ${dockerRunDir}`);
                logger.info(`attachUserDocker. session: ${JSON.stringify(session,null,2)}`);
                let vol_storage;
                let storage_name;
                if (session.params.nfsHomeFolder != "local") {
                    logger.log('info', "Create NFS volume for storage");
                    vol_storage = await docker.createVolume({
                        Name: "nubo_" + session.params.localid + "_storage",
                        DriverOpts : {
                            device: session.params.nfsStorageFolder,
                            o: "addr=" + session.nfs.nfs_ip,
                            type: "nfs4"
                        }
                    });
                    storage_name = vol_storage.name;
                    session.params.volumes.push(vol_storage.name);
                } else {
                    storage_name = session.params.storageFolder;
                    logger.log('info', `Using local folder for storage: ${storage_name}`);
                }
                let startArgs = [
                        'run', '-d',
                        '--name', 'nubo_' + session.params.localid + "_android",
                        '--privileged', '--security-opt', 'label=disable',
                        '--env-file','env',
                        '--network', 'net_sess',
                ];
                let mountArgs = [
                        //'--mount', 'type=tmpfs,destination=/dev,tmpfs-mode=0755',
                        '-v', '/lib/modules:/system/lib/modules:ro',
                        // '-v',`${apksDir}:/system/vendor/apks:ro`,
                        '-v',`${vol_data.name}:/data`,
                        '-v',`${storage_name}:/data/media`,
                        '-v',`${externalSessPath}:/nubo:rw,rshared`,
                ];
                /*if(session.params.audioStreamParams) {
                    if (Common.isDocker) {
                        mountArgs.push(
                            '-v', `/opt/nubo/platform_server/sessions/audio_in_${unum}:/nubo/audio_in:rw,rshared`,
                            '-v', `/opt/nubo/platform_server/sessions/audio_out_${unum}:/nubo/audio_out:rw,rshared`
                        );
                    } else {
                        mountArgs.push(
                            '-v', `/opt/platform_server/sessions/audio_in_${unum}:/nubo/audio_in:rw,rshared`,
                            '-v', `/opt/platform_server/sessions/audio_out_${unum}:/nubo/audio_out:rw,rshared`
                        );
                    }
                }*/
                if (session.params.recording && session.params.recording_path) {
                    let recordingVolName ;
                    if (session.params.nfsHomeFolder != "local") {
                        let nfslocation = session.nfs.nfs_ip + ":" + session.params.recording_path + "/";
                        logger.log('info', `Create NFS volume for recording at: ${nfslocation}`);
                        let vol = await docker.createVolume({
                            Name: "nubo_" + session.params.localid + "_recording",
                            DriverOpts : {
                                device: nfslocation,
                                o: "addr=" + session.nfs.nfs_ip,
                                type: "nfs4"
                            },
                            //rw,rshared
                        });
                        recordingVolName = vol.name;
                        session.params.volumes.push(vol.name);
                    } else {
                        recordingVolName = session.params.recording_path;
                        logger.log('info', `Using local folder for recording: ${recordingVolName}`);
                    }
                    mountArgs.push(
                        '-v', `${recordingVolName}:/nubo/recording`
                    );
                }
                let cmdArgs = ['/init'];
                let args = startArgs.concat(mountArgs, imageName, cmdArgs);
                await saveUserSessionPromise(unum, session);
                console.log("start docker args: ", args);
                const runRes = await execDockerCmd(
                    args,{cwd: dockerRunDir}
                );

                session.params.containerId = runRes.stdout.trim();

                await saveUserSessionPromise(unum, session);
            }



            // wait for launcher to start
            let started = false;
            let cnt = 0;
            let default_launcher;
            if (session.platformSettings && session.platformSettings.default_launcher) {
                default_launcher = session.platformSettings.default_launcher;
            } else {
                default_launcher = "com.nubo.launcher";
            }
            logger.logTime(`Waiting for launcher (${default_launcher}) to start..`);
            while (!started && cnt < 200) {
                cnt++;
                let resps = await execDockerWaitAndroid(
                    ['exec' , session.params.containerId, 'ps', '-A' ]
                );
                if (resps.stdout && resps.stdout.indexOf(default_launcher) >= 0) {
                    started = true;
                } else {
                    sleep(100);
                }
            }


            logger.log('info', `Session created on platform. containerID: ${session.params.containerId}`, logMeta);

        }
        await saveUserSessionPromise(unum,session);
    } catch (err) {
        logger.error(`attachUserDocker. Error: ${err}`,err);
        try {
            await saveUserSessionPromise(unum,session);
            await detachUserDocker(unum);
        } catch (e2) {
            logger.error(`attachUserDocker. detachUserDocker failed: ${e2}`,e2);
        }
        throw err;
    }

    return result;
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


async function detachUserDocker(unum) {
    let logger = Common.getLogger(__filename);
    logger.info(`detachUserDocker. unum: ${unum} `);
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
    let machineConf = machineModule.getMachineConf();
    let saveMachine = false;
    if (session.params.linuxUserName) {
        delete machineConf.linuxUserName[session.params.linuxUserName];
        saveMachine = true;
    }
    let sessKey = `${session.params.email}_${session.params.deviceid}`;
    if (machineConf.sessions && machineConf.sessions[sessKey]) {
        delete machineConf.sessions[sessKey];
        saveMachine = true;
    }
    if (saveMachine) {
        await machineModule.saveMachineConf(machineConf);
    }

    await deleteSessionPromise(unum);

    logger.log('info',`detachUserDocker. User removed.`,logMeta);
    return true;
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
        detachUserDocker(unum).then((result) => {
            var resobj = {
                status: 1,
                message: "User " + unum + " removed"
            };
            res.end(JSON.stringify(resobj,null,2));
        }).catch(err => {
            var resobj = {
                status: 0,
                error: err
            };
            res.end(JSON.stringify(resobj,null,2));
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

