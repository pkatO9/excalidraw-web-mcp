#!/usr/bin/env bash
#
# Reproduces the forked Excalidraw editor with the AI chat sidebar wired in.
#
# Upstream Excalidraw is not vendored into this repo — this script clones it and
# applies our additions on top, so the diff that belongs to this project stays
# visible and upstream stays updatable. Safe to re-run; every step is idempotent.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK_DIR="$REPO_ROOT/excalidraw"
APP_DIR="$FORK_DIR/excalidraw-app"

echo "==> 1/3  Excalidraw checkout"
if [ -d "$FORK_DIR/.git" ]; then
  echo "    already cloned at $FORK_DIR — leaving it alone"
else
  git clone --depth 1 https://github.com/excalidraw/excalidraw.git "$FORK_DIR"
fi

echo "==> 2/3  Copying the agent code in"
mkdir -p "$APP_DIR/ai-agent" "$APP_DIR/tests"
cp "$REPO_ROOT"/app/ai-agent/* "$APP_DIR/ai-agent/"
cp "$REPO_ROOT"/app/tests/* "$APP_DIR/tests/"
echo "    ai-agent/ and tests/ copied"

echo "==> 3/3  Wiring the sidebar into excalidraw-app/App.tsx"
python3 - "$APP_DIR/App.tsx" <<'PY'
import sys, pathlib

path = pathlib.Path(sys.argv[1])
source = path.read_text()

if "ai-agent/ChatSidebar" in source:
    print("    already wired — nothing to do")
    sys.exit(0)

# Placed here rather than beside the other @excalidraw imports so it lands in the
# group eslint's import/order rule expects — otherwise a fresh checkout shows a
# lint overlay on first run.
anchor = 'import CustomStats from "./CustomStats";'
if anchor not in source:
    sys.exit("    !! could not find the import anchor in App.tsx; upstream may have changed")
source = source.replace(
    anchor,
    'import { AIChatSidebar, AIChatToggle } from "./ai-agent/ChatSidebar";\n\n' + anchor,
    1,
)

old_tail = """      </Excalidraw>
    </div>
  );
};"""
new_tail = """        <AIChatSidebar />
      </Excalidraw>
    </div>
  );
};"""
if source.count(old_tail) != 1:
    sys.exit("    !! could not find the <Excalidraw> closing tag; upstream may have changed")
source = source.replace(old_tail, new_tail, 1)

# The AI trigger lives in the editor's top-right cluster next to Excalidraw+ and
# share. Upstream returns null there when collab is unconfigured, which would
# hide our button on a plain local checkout, so the guard is narrowed to mobile.
old_top = """        renderTopRightUI={(isMobile) => {
          if (isMobile || !collabAPI || isCollabDisabled) {
            return null;
          }

          return (
            <div className="excalidraw-ui-top-right">
              {excalidrawAPI?.getEditorInterface().formFactor === "desktop" && (
                <ExcalidrawPlusPromoBanner
                  isSignedIn={isExcalidrawPlusSignedUser}
                />
              )}

              {collabError.message && <CollabError collabError={collabError} />}
              <LiveCollaborationTrigger
                isCollaborating={isCollaborating}
                onSelect={() =>
                  setShareDialogState({ isOpen: true, type: "share" })
                }
                editorInterface={editorInterface}
              />
            </div>
          );
        }}"""
new_top = """        renderTopRightUI={(isMobile) => {
          if (isMobile) {
            return null;
          }

          // Collaboration UI is conditional, but the AI trigger is not — it must
          // still appear when collab is unconfigured, which is the default for a
          // local checkout.
          const showCollabUI = Boolean(collabAPI) && !isCollabDisabled;

          return (
            <div className="excalidraw-ui-top-right">
              {showCollabUI &&
                excalidrawAPI?.getEditorInterface().formFactor ===
                  "desktop" && (
                  <ExcalidrawPlusPromoBanner
                    isSignedIn={isExcalidrawPlusSignedUser}
                  />
                )}

              <AIChatToggle />

              {showCollabUI && collabError.message && (
                <CollabError collabError={collabError} />
              )}
              {showCollabUI && (
                <LiveCollaborationTrigger
                  isCollaborating={isCollaborating}
                  onSelect={() =>
                    setShareDialogState({ isOpen: true, type: "share" })
                  }
                  editorInterface={editorInterface}
                />
              )}
            </div>
          );
        }}"""
if source.count(old_top) != 1:
    sys.exit("    !! could not find renderTopRightUI in App.tsx; upstream may have changed")
source = source.replace(old_top, new_top, 1)

path.write_text(source)
print("    App.tsx wired")
PY

cat <<'DONE'

Setup complete. Next:

  1. Frontend
       cd excalidraw && yarn install && yarn start

  2. Backend (separate terminal)
       cd server && npm install
       cp .env.example .env      # add your provider credentials
       npm start

  Then open the editor and click the "AI" button, top right, next to Excalidraw+ and share.
DONE
