BUILD_ROOT=${BUILD_ROOT:="$PROJ_PATH/debbuild"}/platform_server
Version=${Version:="1.2.0.0"}

echo "NUBO_PROJ_PATH $NUBO_PROJ_PATH"
echo "BUILD_ROOT $BUILD_ROOT"

rm -rf $BUILD_ROOT
mkdir -p $BUILD_ROOT/opt/platform_server
mkdir -p $BUILD_ROOT/opt/platform_server/log
mkdir -p $BUILD_ROOT/opt/platform_server/dist
mkdir -p $BUILD_ROOT/etc/rsyslog.d
mkdir -p $BUILD_ROOT/etc/sudoers.d
mkdir -p $BUILD_ROOT/etc/systemd/system

install -m 755 $PROJ_PATH/dist/pulseaudio-user $BUILD_ROOT/opt/platform_server/dist/pulseaudio-user

cp -a $PROJ_PATH/dist/* $BUILD_ROOT/opt/platform_server/dist/

#Copy js files from git project
#FILES=`git ls-tree --full-tree -r HEAD | awk '$4 ~ /.+\.js$/ {print $4}'`
#for file in ${FILES}; do
#    install -D -m 644 $PROJ_PATH/$file $BUILD_ROOT/opt/platform_server/$file
#done

install -m 644 $PROJ_PATH/Settings.json.init $BUILD_ROOT/opt/platform_server/Settings.json
install -m 644 $PROJ_PATH/platform_server.service $BUILD_ROOT/etc/systemd/system/platform_server.service
install -m 644 $PROJ_PATH/rsyslog-platform_server.conf $BUILD_ROOT/etc/rsyslog.d/18-nubo-platform_server.conf
install -m 644 $PROJ_PATH/etc_sudoers.d_nubo $BUILD_ROOT/etc/sudoers.d/nubo

cp $PROJ_PATH/package.json $BUILD_ROOT/opt/platform_server/
cd $BUILD_ROOT/opt/platform_server/
npm install --only=prod || exit 1
rm package.json
cd -


rsync -r $PROJ_PATH/debbuilder/platform_server/DEBIAN/ $BUILD_ROOT/DEBIAN/
sed "s/%Version%/$Version/g" -i $BUILD_ROOT/DEBIAN/control
