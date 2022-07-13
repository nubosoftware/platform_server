
mkfile_path := $(word $(words $(MAKEFILE_LIST)),$(MAKEFILE_LIST))
nubo_proj_dir:=$(shell cd $(shell dirname $(mkfile_path))/..; pwd)
LINUX_IMG_FULL_PATH:=$(nubo_proj_dir)/nuboplatform/out/target/product/x86_platform/linux.img
LINUX_IMG_FULL_PATH:=/opt/Android-Nougat/linux.img

current_dir := $(shell pwd)
src_js_files_list := $(shell git ls-tree --name-only HEAD src/*.js)

BASE_TAG := nubo_release_3.2
BASE_VERSION := 3.2

define get_project_version
$(eval $1_version=$(BASE_VERSION))
$(eval $1_buildid=$(shell git log $(BASE_TAG)..HEAD --oneline | wc -l))
$(eval $1_buildid=$(shell echo $($1_buildid)+1 | bc))
endef

$(eval $(call get_project_version,platform_server))

default: img

img: $(LINUX_IMG_FULL_PATH) dist/pulseaudio-user
	mkdir mnt
	$(eval LOOPDEVICE := $(shell sudo losetup -f --show $(LINUX_IMG_FULL_PATH) -o $$((2048 * 512)) ))
	@echo "LOOPDEVICE=$(LOOPDEVICE)"
	sudo mount $(LOOPDEVICE) mnt
	sudo bash -c "cat ~/.ssh/id_rsa.pub > mnt/home/nubo/.ssh/authorized_keys"
	sudo bash -c "cat ~/.ssh/id_rsa.pub > mnt/opt/Android/authorized_keys"
	sudo bash -c "cat mnt/home/nubo/.ssh/id_rsa.pub >> mnt/opt/Android/authorized_keys"
	sudo rm -rf mnt/opt/platform_server/node_modules
	sudo rsync ./ mnt/opt/platform_server/ -raF
	@echo "You can change files on platform. Please enter any key to continue and close image";
	@bash -c "read -sn 1";
	sudo umount mnt
	sudo losetup -d $(LOOPDEVICE)
	rmdir mnt

deb: $(nubo_proj_dir)/debs/latest/platform-server-$(platform_server_version)-$(platform_server_buildid).deb

$(nubo_proj_dir)/debs/latest/platform-server-$(platform_server_version)-$(platform_server_buildid).deb: dist/pulseaudio-user dist/restserver.js dist/audiomanager.js
	NUBO_PROJ_PATH=$(nubo_proj_dir) \
	PROJ_PATH=$(current_dir) \
	Version=$(platform_server_version).$(platform_server_buildid) \
	./debbuilder/platform_server/debbuilder.sh && \
	fakeroot dpkg-deb -b debbuild/platform_server $(nubo_proj_dir)/debs/latest/platform-server-$(platform_server_version)-$(platform_server_buildid).deb

rpm: $(nubo_proj_dir)/rpms/latest/nuboplatform_server-$(platform_server_version)-$(platform_server_buildid).x86_64.rpm

$(nubo_proj_dir)/rpms/latest/nuboplatform_server-$(platform_server_version)-$(platform_server_buildid).x86_64.rpm: dist/pulseaudio-user dist/restserver.js dist/audiomanager.js
	NUBO_PROJ_PATH=$(nubo_proj_dir) \
	PROJ_PATH=$(current_dir) \
	rpmbuild -v \
	--define "_topdir $(current_dir)/rpmbuild" \
	--define "_version $(platform_server_version)" \
	--define "_release $(platform_server_buildid)" \
	--define "_build_id_links none" \
	-bb rpmbuild/SPECS/platform_server.spec
	cp $(nubo_proj_dir)/platform_server/rpmbuild/RPMS/x86_64/nuboplatform_server-$(platform_server_version)-$(platform_server_buildid).x86_64.rpm $(nubo_proj_dir)/rpms/latest/

$(LINUX_IMG_FULL_PATH):
	scp nubo@lab2.nubosoftware.com:N7/linux.img $(LINUX_IMG_FULL_PATH)

dist:
	mkdir dist

dist/pulseaudio-user: src/pulseaudio-user-gst.cpp dist
	g++ $< -o $@ -lpulse -lpthread -lpulse-simple `pkg-config --cflags --libs gstreamer-1.0`

dist/restserver.js: $(src_js_files_list) dist
	node --max_old_space_size=10240 ./node_modules/webpack/bin/webpack.js --progress=profile --mode production --config webpack.config-restserver.js

dist/audiomanager.js: src/audiomanager.js dist
	node --max_old_space_size=10240 ./node_modules/webpack/bin/webpack.js --progress=profile --mode production --config webpack.config-audiomanager.js

# docker: deb
# 	mkdir -p docker_build/debs/
# 	cp $(nubo_proj_dir)/debs/latest/platform-server-$(platform_server_version)-$(platform_server_buildid).deb docker_build/debs/platform-server.deb
# 	cp $(nubo_proj_dir)/debs/latest/nubo-common-3.0-1.deb docker_build/debs/nubo-common.deb
# 	sudo docker build -t nuboplatformserver:$(platform_server_version)-$(platform_server_buildid) docker_build/.
#
docker:
	docker build --build-arg BUILD_VER=$(platform_server_version)-$(platform_server_buildid) --no-cache --pull -f docker_build/Dockerfile -t nuboplatformserver:$(platform_server_version)-$(platform_server_buildid) .

push-test:
	docker build --build-arg BUILD_VER=$(platform_server_version)-$(platform_server_buildid) -f docker_build/Dockerfile -t nuboplatformserver:test .
	docker tag nuboplatformserver:test docker.nubosoftware.com:5000/nubo/platformserver:test
	docker push docker.nubosoftware.com:5000/nubo/platformserver:test

push-nubo: docker
	docker tag nuboplatformserver:$(platform_server_version)-$(platform_server_buildid) docker.nubosoftware.com:5000/nubo/platformserver:$(platform_server_version)-$(platform_server_buildid)
	docker push docker.nubosoftware.com:5000/nubo/platformserver:$(platform_server_version)-$(platform_server_buildid)
	docker tag nuboplatformserver:$(platform_server_version)-$(platform_server_buildid) docker.nubosoftware.com:5000/nubo/platformserver:$(platform_server_version)
	docker push docker.nubosoftware.com:5000/nubo/platformserver:$(platform_server_version)

push-nubo-latest: push-nubo
	docker tag nuboplatformserver:$(platform_server_version)-$(platform_server_buildid) docker.nubosoftware.com:5000/nubo/platformserver
	docker push docker.nubosoftware.com:5000/nubo/platformserver

push-hub: docker
	docker tag nuboplatformserver:$(platform_server_version)-$(platform_server_buildid) nubosoftware/nuboplatformserver:$(platform_server_version)-$(platform_server_buildid)
	docker push nubosoftware/nuboplatformserver:$(platform_server_version)-$(platform_server_buildid)
	docker tag nuboplatformserver:$(platform_server_version)-$(platform_server_buildid) nubosoftware/nuboplatformserver:$(platform_server_version)
	docker push nubosoftware/nuboplatformserver:$(platform_server_version)

push-hub-latest: push-hub
	docker tag nuboplatformserver:$(platform_server_version)-$(platform_server_buildid) nubosoftware/nuboplatformserver
	docker push nubosoftware/nuboplatformserver

.PHONY: deb default img rpm docker

