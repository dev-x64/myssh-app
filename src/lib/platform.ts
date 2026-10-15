// Which system the app is running on. It was written for the Mac; on
// Windows a few things are named differently and a few are done differently.

export const WINDOWS = /Windows/i.test(navigator.userAgent);
