// Which system the app is running on. It was written for the Mac; on
// Windows and Linux a few things are named differently and a few are done
// differently.

export const WINDOWS = /Windows/i.test(navigator.userAgent);
/** Linux (WebKitGTK says so in its user agent; Android is not a desktop). */
export const LINUX = !WINDOWS && /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);
export const MAC = !WINDOWS && !LINUX;
