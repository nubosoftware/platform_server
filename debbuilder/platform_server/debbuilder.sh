BUILD_ROOT=${BUILD_ROOT:="$PROJ_PATH/debbuild"}/platform_server
Version=${Version:="1.2.0.0"}

echo "NUBO_PROJ_PATH $NUBO_PROJ_PATH"
echo "BUILD_ROOT $BUILD_ROOT"

rm -rf $BUILD_ROOT
mkdir -p $BUILD_ROOT/opt/platform_server
mkdir -p $BUILD_ROOT/opt/platform_server/log
mkdir -p $BUILD_ROOT/etc/init.d
mkdir -p $BUILD_ROOT/etc/rsyslog.d

#Copy js files from git project
FILES=`git ls-tree --full-tree -r HEAD | awk '$4 ~ /.+\.js$/ {print $4}'`
for file in ${FILES}; do
    install -D -m 644 $PROJ_PATH/$file $BUILD_ROOT/opt/platform_server/$file
done
install -m 644 $PROJ_PATH/Settings.json.init $BUILD_ROOT/opt/platform_server/Settings.json
install -m 755 $PROJ_PATH/platform_server $BUILD_ROOT/etc/init.d/platform_server
echo "install -m 755 $PROJ_PATH/platform_server $BUILD_ROOT/etc/init.d/platform_server"
install -m 644 $PROJ_PATH/rsyslog-platform_server.conf $BUILD_ROOT/etc/rsyslog.d/18-nubo-platform_server.conf

cp $PROJ_PATH/package.json $BUILD_ROOT/opt/platform_server/
cd $BUILD_ROOT/opt/platform_server/
npm install
rm package.json
cd -


rsync -r $PROJ_PATH/debbuilder/platform_server/DEBIAN/ $BUILD_ROOT/DEBIAN/
sed "s/%Version%/$Version/g" -i $BUILD_ROOT/DEBIAN/control
