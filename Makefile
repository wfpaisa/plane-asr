NAME=planeasr
DOMAIN=wfelipe.com
# gettext domain, must match metadata.json "gettext-domain" and po/*.po
GETTEXT_DOMAIN=planeasr

# 'zip' is required to build the extension package for gnome-extensions.
ZIP := $(shell command -v zip 2>/dev/null)
# 'msgfmt' (gettext) is required to compile translations into .mo files.
MSGFMT := $(shell command -v msgfmt 2>/dev/null)
# 'xgettext' (gettext) is required to regenerate the .pot template.
XGETTEXT := $(shell command -v xgettext 2>/dev/null)

.PHONY: all pack install clean pot locale

all: dist/extension.js

node_modules/.modules.yaml: package.json
	pnpm install

TS_SOURCES := extension.ts prefs.ts $(shell find src -name '*.ts')

dist/extension.js dist/prefs.js: node_modules/.modules.yaml $(TS_SOURCES) data/model-catalog.json
	pnpm run build

# Regenerate the gettext template from the translatable sources listed in
# po/POTFILES.in. Run after adding/changing any _('...') string, then update
# the .po files (msgmerge).
po/$(GETTEXT_DOMAIN).pot: po/POTFILES.in $(TS_SOURCES)
ifndef XGETTEXT
	$(error 'xgettext' is required to regenerate the translations template but was not found in PATH. \
Install it and retry: Arch: sudo pacman -S gettext | Debian/Ubuntu: sudo apt install gettext | Fedora: sudo dnf install gettext)
endif
	xgettext \
		--keyword=_ --keyword=N_ --keyword=C_:1c,2 \
		--from-code=UTF-8 --language=JavaScript --add-comments=TRANSLATORS: \
		--package-name=$(NAME) --package-version=0.0.0 \
		--msgid-bugs-address=https://github.com/wfpaisa/plane-asr/issues \
		-f po/POTFILES.in -o po/$(GETTEXT_DOMAIN).pot

# Phony convenience target to (re)build the .pot template.
pot: po/$(GETTEXT_DOMAIN).pot

# Compile every po/<lang>.po into dist/locale/<lang>/LC_MESSAGES/<domain>.mo,
# so GNOME Shell's initTranslations() finds them under <extdir>/locale.
# Order-only dependency on the compile step: `pnpm run build` wipes dist/ to
# drop stale outputs of deleted sources, so locale must run *after* it or its
# .mo files would be erased.
locale: po/$(GETTEXT_DOMAIN).pot | dist/extension.js
ifndef MSGFMT
	$(error 'msgfmt' (gettext) is required to compile translations but was not found in PATH. \
Install it and retry: Arch: sudo pacman -S gettext | Debian/Ubuntu: sudo apt install gettext | Fedora: sudo dnf install gettext)
endif
	@for po in po/*.po; do \
		lang=$$(basename $$po .po); \
		mkdir -p dist/locale/$$lang/LC_MESSAGES; \
		msgfmt -o dist/locale/$$lang/LC_MESSAGES/$(GETTEXT_DOMAIN).mo $$po; \
	done

$(NAME)@$(DOMAIN).zip: dist/extension.js dist/prefs.js locale
ifndef ZIP
	$(error 'zip' is required to build $(NAME)@$(DOMAIN).zip but was not found in PATH. \
Install it and retry: Arch: sudo pacman -S zip | Debian/Ubuntu: sudo apt install zip | Fedora: sudo dnf install zip)
endif
	@rm -rf dist/schemas dist/data
	@mkdir -p dist/schemas
	@cp schemas/*.gschema.xml dist/schemas/
	@cp -r data dist/
	@cp metadata.json dist/
	@cp stylesheet.css dist/
	@rm -f $(NAME)@$(DOMAIN).zip
	@(cd dist && zip ../$(NAME)@$(DOMAIN).zip -9r .)

pack: $(NAME)@$(DOMAIN).zip

install: $(NAME)@$(DOMAIN).zip
	gnome-extensions install --force $(NAME)@$(DOMAIN).zip

clean:
	@rm -rf dist node_modules $(NAME)@$(DOMAIN).zip schemas/gschemas.compiled
