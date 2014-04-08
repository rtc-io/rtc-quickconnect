#!/usr/bin/env bash
DEBUG_OPTS="--enable-logging --v=1 --vmodule=*third_party/libjingle/*=3,*=0"
EXTRA_OPTS="--no-sandbox --disable-setuid-sandbox --allow-sandbox-debugging"

google-chrome \
  --console \
  --no-first-run $DEBUG_OPTS \
  --use-fake-device-for-media-stream \
  --use-fake-ui-for-media-stream $@ \
  --user-data-dir
