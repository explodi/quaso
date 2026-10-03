// SPDX-License-Identifier: MIT
import { Kbd } from "../../components/Typography.tsx";
import { Table } from "../../components/Controls.tsx";
/** The editor's keyboard shortcuts, in a dialog ("?" opens it). */
import { Dialog } from "../../components/Dialog.tsx";
import { isMac, shortcutList } from "../../lib/shortcuts.ts";

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const mac = isMac();
  const shortcuts = shortcutList(mac);
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      <Table className="shortcuts">
        <thead>
          <tr>
            <th scope="col">Keys</th>
            <th scope="col">What they do</th>
          </tr>
        </thead>
        <tbody>
          {shortcuts.map((shortcut) => (
            <tr key={shortcut.description}>
              <td>
                {shortcut.keys.map((combination, i) => (
                  <span key={i} className="key-combination">
                    {i > 0 && (
                      <>
                        {" "}
                        <span className="muted">or</span>{" "}
                      </>
                    )}
                    {combination.map((key, j) => (
                      <span key={j}>
                        {j > 0 && "+"}
                        <Kbd>{key}</Kbd>
                      </span>
                    ))}
                  </span>
                ))}
              </td>
              <td>{shortcut.description}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="muted small">
        {mac
          ? "On a Mac, ⌥ with a digit types characters such as { and [, so placeholders go in with Control and the digit. Clicking a chip inserts it too."
          : "Browsers keep Ctrl+1…9 for switching tabs, so placeholders go in with Alt and the digit. Clicking a chip inserts it too."}
      </p>
    </Dialog>
  );
}
