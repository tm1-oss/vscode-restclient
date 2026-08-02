export enum RequestMetadata {
    /**
     * Represents a request name and used to indicate that the request is a named request
     */
    Name = 'name',
    /**
     * Used for request confirmation, especially for critical request
     */
    Note = 'note',
    /**
     * Represents don't follow the 3XX response as redirects
     */
    NoRedirect = 'no-redirect',

    /**
     * Represents the cookie jar is disabled for this request
     */
    NoCookieJar = 'no-cookie-jar',

    /**
     * Used to allow user to interactively input variables for this request
     */
    Prompt = 'prompt',

    /**
     * Keep retrying the request (with a short delay between attempts) until all
     * tests pass (or there are no tests and the response is received without error).
     * The loop respects cancellation — pressing Cancel stops retrying immediately.
     */
    AsyncRetry = 'async-retry',
}

export function fromString(value: string): RequestMetadata | undefined {
    value = value.toLowerCase();
    const enumName = (Object.keys(RequestMetadata) as Array<keyof typeof RequestMetadata>).find(k => RequestMetadata[k] === value);
    return enumName ? RequestMetadata[enumName] : undefined;
}