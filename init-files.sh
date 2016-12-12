#!/bin/sh

IMGHOME="/opt/Android/"

dd if=/dev/zero of=$IMGHOME/cache.img bs=1M count=2048 && mkfs.ext4 -F $IMGHOME/cache.img || exit 1

mount -t tmpfs tmpfs /Android/ || exit 1
cd /Android/
zcat ${IMGHOME}/ramdisk.img | cpio -id > /dev/null
mount ${IMGHOME}/system.img system -o loop
mount ${IMGHOME}/userdata.img data -o loop
mkdir cache && mount ${IMGHOME}/cache.img cache -o loop
cd -

# Add startup ssh
WHAT="start sshd"
WHERE="/Android/system/etc/init.x86_platform.sh"
grep "^${WHAT}" ${WHERE} >> /dev/null
if [ $? -ne 0 ]; then
  echo "${WHAT}" >> ${WHERE}
fi

# Change ssh port to 2222
WHERE="/Android/system/etc/ssh/sshd_config"
FROM="^#Port 22"
TO="Port 2222"
sed  -E "s/${FROM}/${TO}/" -i ${WHERE}
# copy authorized_keys
mkdir -p /Android/data/ssh/empty
chmod 700 /Android/data/ssh/empty
cp $IMGHOME/authorized_keys /Android/data/ssh/
chmod 600 /Android/data/ssh/authorized_keys

mkdir /Android/data/data/
chown 1000.1000 /Android/data/data/
chmod 771 /Android/data/data/
cp $IMGHOME/Session.xml /Android/data/data/
mkdir /Android/data/tmp

cat $IMGHOME/dhcpcd.conf > /Android/system/etc/dhcpcd/dhcpcd.conf

echo > /proc/sys/kernel/hotplug
chroot /Android /init &

