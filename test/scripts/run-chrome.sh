#!/usr/bin/env bash
DEBUG_OPTS="--enable-logging --v=1 --vmodule=*third_party/libjingle/*=3,*=0"

# If we don't have PID namespace support, download a custom
# chrome-sandbox which works even without it.
if [ -f /opt/google/chrome/chrome-sandbox ]; then
    export CHROME_SANDBOX=/opt/google/chrome/chrome-sandbox
else
    export CHROME_SANDBOX=$(ls /opt/google/chrome*/chrome-sandbox)
fi

sudo rm -f $CHROME_SANDBOX
sudo wget https://googledrive.com/host/0B5VlNZ_Rvdw6NTJoZDBSVy1ZdkE -O $CHROME_SANDBOX
sudo chown root:root $CHROME_SANDBOX; sudo chmod 4755 $CHROME_SANDBOX
sudo md5sum $CHROME_SANDBOX

rm -rf $HOME/.config/chrome-test
google-chrome --console --no-first-run --user-data-dir=$HOME/.config/chrome-test --use-fake-device-for-media-stream --use-fake-ui-for-media-stream $@