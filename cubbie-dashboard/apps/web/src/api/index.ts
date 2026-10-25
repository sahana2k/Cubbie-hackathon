import { createLocalApi } from './local';
import type { Api } from './types';
export const api: Api = createLocalApi('/api');
export type { Api, TaskDraft } from './types';
