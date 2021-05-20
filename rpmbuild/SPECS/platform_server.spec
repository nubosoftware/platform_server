Summary: platform service
Name: nuboplatform_server
Version: %{_version}
Release: %{_release}
Group: System Environment/Daemons
BuildArch: x86_64
License: none
Requires: nodejs, android-dkms, nubouserfs-dkms, nubo-common, wget, nfs-utils, fuse, pulseaudio, pulseaudio-utils, gstreamer1, gstreamer1-plugins-base, gstreamer1-plugins-good, gstreamer1-plugins-bad-free, gstreamer1-plugins-ugly-free

%description
Service that implement api of possible requests to nubo platform

#%prep
#%setup -q
#%patch -p1 -b .buildroot

%build

%install
rm -rf $RPM_BUILD_ROOT
mkdir -p $RPM_BUILD_ROOT/opt/platform_server
mkdir -p $RPM_BUILD_ROOT/etc/systemd/system
mkdir -p $RPM_BUILD_ROOT/etc/rsyslog.d

#Copy js files from git project
FILES=`git ls-tree --full-tree -r HEAD | awk '$4 ~ /.+\.js$/ {print $4}'`
for file in ${FILES}; do
    install -D -m 644 $PROJ_PATH/$file $RPM_BUILD_ROOT/opt/platform_server/$file
done
install -m 644 $PROJ_PATH/Settings.json.init $RPM_BUILD_ROOT/opt/platform_server/Settings.json
install -m 644 $PROJ_PATH/platform_server.service $RPM_BUILD_ROOT/etc/systemd/system/platform_server.service
install -m 644 $PROJ_PATH/rsyslog-platform_server.conf $RPM_BUILD_ROOT/etc/rsyslog.d/18-nubo-platform_server.conf
install -m 644 $PROJ_PATH/package.json $RPM_BUILD_ROOT/opt/platform_server/package.json
install -m 755 $PROJ_PATH/init-files.sh $RPM_BUILD_ROOT/opt/platform_server/init-files.sh
install -m 755 $PROJ_PATH/pulseaudio-user $RPM_BUILD_ROOT/opt/platform_server/pulseaudio-user

cd $RPM_BUILD_ROOT/opt/platform_server
npm install
rm package.json
find $RPM_BUILD_ROOT/opt/platform_server/node_modules -type f -exec sed "s?$RPM_BUILD_ROOT?/?g" -i {} \;
cd -

%post
systemctl enable platform_server
mkdir /opt/platform_server/sessions ||:
mkdir /Android ||:
mkdir /opt/Android ||:
mkdir /opt/platform_server/sessions ||:

systemctl enable platform_server > /dev/null 2>&1 ||:

#Restart after every install/update
systemctl restart platform_server > /dev/null 2>&1 ||:

%preun
if [ $1 = 0 ]; then
	#Stop service and remove from services list on full remove
	systemctl disable platform_server > /dev/null 2>&1 ||:
	systemctl stop platform_server > /dev/null 2>&1 ||:
fi

%postun
if [ "$1" -ge "1" ]; then
	#Restart service after downgrade
	systemctl restart platform_server > /dev/null 2>&1 ||:
fi

%clean
rm -rf $RPM_BUILD_ROOT

%files
%defattr(-,root,root)

/opt/platform_server
%config(noreplace) /opt/platform_server/Settings.json
/etc/systemd/system/platform_server.service
%config(noreplace) /etc/rsyslog.d/18-nubo-platform_server.conf

