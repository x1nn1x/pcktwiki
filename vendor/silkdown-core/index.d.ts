import { baseTheme } from './theme.js';
import { defaultUrlPolicy } from './url.js';
import { Extension } from '@codemirror/state';
import { languages } from '@codemirror/language-data';
import { markdownKeymap } from './shortcuts.js';
import { safeUrl } from './url.js';
import { silkdownPlugin } from './plugin.js';
import { SilkdownPluginOptions } from './plugin.js';
import { UrlPolicy } from './url.js';

export { baseTheme }

export { defaultUrlPolicy }

export { markdownKeymap }

export { safeUrl }

export declare function silkdown(opts?: SilkdownOptions): Extension;

export declare interface SilkdownOptions extends SilkdownPluginOptions {
    /**
     * Provide highlighters for fenced code blocks. Defaults to the full
     * `@codemirror/language-data` array (lazy-loaded by Lezer).
     */
    codeLanguages?: typeof languages;
}

export { silkdownPlugin }

export { SilkdownPluginOptions }

export { UrlPolicy }

export { }
