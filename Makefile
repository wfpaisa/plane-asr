NAME=planeasr
DOMAIN=wfelipe.com

# 'zip' is required to build the extension package for gnome-extensions.
ZIP := $(shell command -v zip 2>/dev/null)

.PHONY: all pack install clean

all: dist/extension.js

node_modules/.modules.yaml: package.json
	pnpm install

dist/extension.js dist/prefs.js: node_modules/.modules.yaml *.ts
	pnpm run build

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.$(NAME).gschema.xml
	glib-compile-schemas schemas

$(NAME)@$(DOMAIN).zip: dist/extension.js dist/prefs.js schemas/gschemas.compiled
ifndef ZIP
	$(error 'zip' is required to build $(NAME)@$(DOMAIN).zip but was not found in PATH. \
Install it and retry: Arch: sudo pacman -S zip | Debian/Ubuntu: sudo apt install zip | Fedora: sudo dnf install zip)
endif
	@cp -r schemas dist/
	@cp metadata.json dist/
	@cp stylesheet.css dist/
	@(cd dist && zip ../$(NAME)@$(DOMAIN).zip -9r .)

pack: $(NAME)@$(DOMAIN).zip

install: $(NAME)@$(DOMAIN).zip
	gnome-extensions install --force $(NAME)@$(DOMAIN).zip

clean:
	@rm -rf dist node_modules $(NAME)@$(DOMAIN).zip schemas/gschemas.compiled
