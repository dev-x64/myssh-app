// A web address tapped in a terminal on a phone. A tap there is also how the
// keyboard is brought up, so a link is not opened at once: it is offered, to
// open in the browser or to copy.

import { create } from "zustand";

export const useLinkOffer = create<{ url: string | null; offer: (url: string | null) => void }>((set) => ({
  url: null,
  offer: (url) => set({ url }),
}));
