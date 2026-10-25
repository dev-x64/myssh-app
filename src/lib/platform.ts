// Which system the app is running on. It was written for the Mac; on
// Windows and Linux a few things are named differently and a few are done
// differently. On a phone the window is laid out anew, for a finger.

export const WINDOWS = /Windows/i.test(navigator.userAgent);
/** Android: a phone or a tablet, held in the hand and touched. */
export const ANDROID = /Android/i.test(navigator.userAgent);
/** Linux (WebKitGTK says so in its user agent; Android is not a desktop). */
export const LINUX = !WINDOWS && /Linux/i.test(navigator.userAgent) && !ANDROID;
export const MAC = !WINDOWS && !LINUX && !ANDROID;
/** The layout for a touch screen: one thing at a time, the tabs at the bottom. */
export const MOBILE = ANDROID;
/**
 * Pro can be bought from inside the app. Not on Android: the app comes from
 * Google Play, whose rules allow no other way to pay inside it, and no link
 * to one. Pro bought on the website shows there by itself once signed in.
 */
export const SELLS_PRO = !ANDROID;
