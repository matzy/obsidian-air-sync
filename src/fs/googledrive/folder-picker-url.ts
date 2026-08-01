const FOLDER_PICKER_URL = "https://airsync.takezo.dev/googledrive-folder";

/** Public, referrer-restricted Google Picker key. It is not an authentication secret. */
const PICKER_API_KEY = "AIzaSyDyXTKejmlaTcBIDCx3lJYFhDMmyRKRZwc";

export interface GoogleDriveFolderPickerUrlOptions {
	state: string;
	accessToken: string;
	/** Test seam for the live invalid-key control; production callers omit this. */
	apiKey?: string;
}

/**
 * Build the production Google Picker relay URL. The access token must remain in the
 * fragment so it is never sent to the relay host; query parameters precede it.
 */
export function buildGoogleDriveFolderPickerUrl({
	state,
	accessToken,
	apiKey = PICKER_API_KEY,
}: GoogleDriveFolderPickerUrlOptions): string {
	return `${FOLDER_PICKER_URL}?state=${encodeURIComponent(state)}&apiKey=${encodeURIComponent(apiKey)}#token=${encodeURIComponent(accessToken)}`;
}
