// A file chosen through the page's own picker. On a phone the system's
// picker answers with something only it can open (a content:// address),
// which the app's core cannot read as a path; the page can read the file.

/** The file picked, or `null` if the picker was put away. */
export function pickLocalFile(accept?: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}
