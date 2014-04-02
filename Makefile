MODULE_NAME := quickconnect
REQUIRED_TOOLS := browserify uglifyjs st inotifywait
PORT ?= 8000

PHONY: dist

$(REQUIRED_TOOLS):
	@hash $@ 2>/dev/null || (echo "please install $@" && exit 1)

dist: $(REQUIRED_TOOLS)
	@mkdir -p dist

	@echo "building"
	@browserify index.js > dist/$(MODULE_NAME).js --debug --standalone $(MODULE_NAME)

	@echo "minifying"
	@uglifyjs dist/$(MODULE_NAME).js > dist/$(MODULE_NAME).min.js 2>/dev/null

devmode: dist
	st --port $(PORT) --no-cache &

	while true; do inotifywait -e create -e delete -e modify -q -r *.js node_modules || make dist; done