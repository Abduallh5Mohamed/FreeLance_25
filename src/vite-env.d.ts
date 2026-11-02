/// <reference types="vite/client" />

interface Window {
    /**
     * Set by `startVersionCheck()` purely as a side effect that prevents the
     * version checker from being tree-shaken out of the production bundle.
     * It carries no state and is never read back.
     */
    __APP_VERSION_CHECK_ENABLED__?: boolean;
}
