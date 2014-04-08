#!/usr/bin/env bash
DEBUG_OPTS="--enable-logging --v=1 --vmodule=*third_party/libjingle/*=3,*=0"

rm -rf $HOME/.config/chrome-test
google-chrome --console --no-first-run --user-data-dir=$HOME/.config/chrome-test --use-fake-device-for-media-stream --use-fake-ui-for-media-stream $@