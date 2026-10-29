// Importing this module loads every domain table; consumers import `t` from here, never from registry.
import './zh/git'; import './en/git';
import './zh/agent'; import './en/agent';
import './zh/creator'; import './en/creator';
import './zh/inspector'; import './en/inspector';
import './zh/preview'; import './en/preview';
import './zh/main'; import './en/main';
import './zh/panel'; import './en/panel';
import './zh/misc'; import './en/misc';
import './zh/common'; import './en/common';
export { t, has, language, setLanguage, register, missing, MessageError } from './registry';
export type { Language, Table, Params } from './registry';
