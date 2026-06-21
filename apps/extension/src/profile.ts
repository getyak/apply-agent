// User profile — the "70% of fields" that get filled locally with zero LLM cost.
//
// Stored in chrome.storage.local (vision.md "privacy first": never leaves the
// device unless the user explicitly asks the cloud LLM via T7). The shape is
// deliberately flat — no nested JSON Resume; the local filler doesn't need it.
//
// Caller: popup.ts edits this through a textarea; content.ts reads it via
// fillForm() at fill time.

export interface UserProfile {
  // Identity
  firstName: string;
  lastName: string;
  fullName: string; // computed when both above are set, but stored explicitly so
  //                    pages that have a single "name" field still get filled
  //                    correctly when the user wrote "Alice E." in their profile
  email: string;
  phone: string; // E.164 preferred but not enforced
  // Location
  city: string;
  state: string;
  country: string;
  // Links
  linkedin: string;
  github: string;
  website: string;
  portfolio: string;
  // Work auth (free-form; sensitive enough that fills propose, never assert)
  workAuthorization: string; // e.g. "US Citizen", "EU national", "F-1 OPT"
  needsSponsorship: 'yes' | 'no' | '';
}

export const EMPTY_PROFILE: UserProfile = {
  firstName: '',
  lastName: '',
  fullName: '',
  email: '',
  phone: '',
  city: '',
  state: '',
  country: '',
  linkedin: '',
  github: '',
  website: '',
  portfolio: '',
  workAuthorization: '',
  needsSponsorship: '',
};

const STORAGE_KEY = 'vantage.profile.v1';

export async function loadProfile(): Promise<UserProfile> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (items) => {
      const raw = items[STORAGE_KEY];
      if (raw && typeof raw === 'object') {
        resolve({ ...EMPTY_PROFILE, ...(raw as Partial<UserProfile>) });
      } else {
        resolve({ ...EMPTY_PROFILE });
      }
    });
  });
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: profile }, () => resolve());
  });
}

/**
 * PROFILE4 (round-18): the round-18 audit found we had no way to
 * wipe the stored profile from extension memory. saveProfile() only
 * overwrites the object — even a "save empty profile" leaves the
 * STORAGE_KEY present in chrome.storage.local. That violates the
 * GDPR "right to deletion" the rest of the privacy story relies on
 * and contradicts the vision.md "privacy first" line in the file
 * header. chrome.storage.local.remove() is the right primitive: it
 * removes the entry entirely. Caller (popup.ts "Clear profile"
 * button, round-18) confirms with the user first.
 */
export async function clearProfile(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove([STORAGE_KEY], () => resolve());
  });
}
