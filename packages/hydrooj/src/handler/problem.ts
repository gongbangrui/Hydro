import { isSafeInteger, flatten, pick } from 'lodash';
import yaml from 'js-yaml';
import { FilterQuery, ObjectID } from 'mongodb';
import AdmZip from 'adm-zip';
import {
    NoProblemError, ProblemDataNotFoundError, BadRequestError,
    SolutionNotFoundError, ProblemNotFoundError, ValidationError,
    PermissionError,
} from '../error';
import { streamToBuffer } from '../utils';
import {
    Pdoc, User, Rdoc, PathComponent,
} from '../interface';
import paginate from '../lib/paginate';
import { isTitle, isContent, isPid } from '../lib/validator';
import { ProblemAdd } from '../lib/ui';
import * as file from '../model/file';
import * as problem from '../model/problem';
import * as record from '../model/record';
import * as domain from '../model/domain';
import * as user from '../model/user';
import * as solution from '../model/solution';
import { PERM, PRIV, CONSTANT } from '../model/builtin';
import * as bus from '../service/bus';
import {
    Route, Connection, Handler, ConnectionHandler, Types, param, post, route,
} from '../service/server';

export const parseCategory = (value: string) => flatten(value.split('+').map((e) => e.split(','))).map((e) => e.trim());
export const parsePid = (value: string) => (isSafeInteger(value) ? parseInt(value, 10) : value);

export class ProblemHandler extends Handler {
    async __prepare() {
        this.checkPerm(PERM.PERM_VIEW_PROBLEM);
    }

    async cleanup() {
        if (this.response.template === 'problem_main.html' && this.request.json) {
            const {
                path, page, pcount, ppcount, pdocs, psdict, category,
            } = this.response.body;
            this.response.body = {
                title: this.renderTitle(category),
                fragments: (await Promise.all([
                    this.renderHTML('partials/problem_list.html', {
                        page, ppcount, pcount, pdocs, psdict,
                    }),
                    this.renderHTML('partials/problem_stat.html', { pcount }),
                    this.renderHTML('partials/problem_lucky.html', { category }),
                    this.renderHTML('partials/path.html', { path }),
                ])).map((i) => ({ html: i })),
                raw: {
                    path, page, pcount, ppcount, pdocs, psdict, category,
                },
            };
        }
    }
}

export class ProblemMainHandler extends ProblemHandler {
    @param('page', Types.PositiveInt, true)
    @param('q', Types.String, true)
    async get(domainId: string, page = 1, q = '') {
        this.response.template = 'problem_main.html';
        const query: FilterQuery<Pdoc> = {};
        let psdict = {};
        const path: PathComponent[] = [
            ['Hydro', 'homepage'],
            ['problem_main', null],
        ];
        if (q) {
            query.$text = { $search: q };
            path.push([q, null, null, true]);
        }
        if (!this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) query.hidden = false;
        await bus.serial('problem/list', query, this);
        const [pdocs, ppcount, pcount] = await paginate(
            problem.getMulti(domainId, query).sort({ pid: 1, docId: 1 }),
            page,
            CONSTANT.PROBLEM_PER_PAGE,
        );
        if (this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            psdict = await problem.getListStatus(
                domainId, this.user._id, pdocs.map((pdoc) => pdoc.docId),
            );
        }
        this.response.body = {
            path, page, pcount, ppcount, pdocs, psdict, category: q,
        };
    }

    @param('pid', Types.UnsignedInt)
    async postStar(domainId: string, pid: number) {
        await problem.setStar(domainId, pid, this.user._id, true);
        this.back({ star: true });
    }

    @param('pid', Types.UnsignedInt)
    async postUnstar(domainId: string, pid: number) {
        await problem.setStar(domainId, pid, this.user._id, false);
        this.back({ star: false });
    }
}

export class ProblemCategoryHandler extends ProblemHandler {
    @param('page', Types.PositiveInt, true)
    @param('category', Types.String, null, parseCategory)
    async get(domainId: string, page = 1, category: string[]) {
        this.response.template = 'problem_main.html';
        const q: any = { $and: [] };
        for (const name of category) {
            q.$and.push({
                $or: [
                    { category: { $elemMatch: { $eq: name } } },
                    { tag: { $elemMatch: { $eq: name } } },
                ],
            });
        }
        let psdict = {};
        if (!this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) q.hidden = false;
        await bus.serial('problem/list', q, this);
        const [pdocs, ppcount, pcount] = await paginate(
            problem.getMulti(domainId, q).sort({ pid: 1, docId: 1 }),
            page,
            CONSTANT.PROBLEM_PER_PAGE,
        );
        if (this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            psdict = await problem.getListStatus(
                domainId, this.user._id, pdocs.map((pdoc) => pdoc.docId),
            );
        }
        const path = [
            ['Hydro', 'homepage'],
            ['problem_main', 'problem_main'],
            [category, null, null, true],
        ];
        this.response.body = {
            path, page, pcount, ppcount, pdocs, psdict, category: category.join('+'),
        };
    }
}

export class ProblemRandomHandler extends ProblemHandler {
    @param('category', Types.String, true, null, parseCategory)
    async get(domainId: string, category: string[] = []) {
        const q: any = category.length ? { $and: [] } : {};
        for (const name of category) {
            if (name) {
                q.$and.push({
                    $or: [
                        { category: { $elemMatch: { $eq: name } } },
                        { tag: { $elemMatch: { $eq: name } } },
                    ],
                });
            }
        }
        if (!this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) q.hidden = false;
        await bus.serial('problem/list', q, this);
        const pid = await problem.random(domainId, q);
        if (!pid) throw new NoProblemError();
        this.response.body = { pid };
        this.response.redirect = this.url('problem_detail', { pid });
    }
}

export class ProblemDetailHandler extends ProblemHandler {
    pdoc: Pdoc;

    udoc: User;

    @route('pid', Types.String, true, null, parsePid)
    async _prepare(domainId: string, pid: number | string) {
        this.response.template = 'problem_detail.html';
        this.pdoc = await problem.get(domainId, pid, this.user._id);
        if (!this.pdoc) throw new ProblemNotFoundError(domainId, pid);
        if (this.pdoc.hidden && this.pdoc.owner !== this.user._id) {
            this.checkPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN);
        }
        await bus.serial('problem/get', this.pdoc, this);
        this.udoc = await user.getById(domainId, this.pdoc.owner);
        this.response.body = {
            pdoc: this.pdoc,
            udoc: this.udoc,
            title: this.pdoc.title,
            path: [
                ['Hydro', 'homepage'],
                ['problem_main', 'problem_main'],
                [this.pdoc.title, null, true],
            ],
        };
    }

    async get(...args: any[]) { } // eslint-disable-line

    @param('pid', Types.UnsignedInt)
    @param('dest', Types.String)
    @param('hidden', Types.Boolean)
    async postCopy(domainId: string, pid: number, destDomainId: string, hidden = false) {
        const udoc = await user.getById(destDomainId, this.user._id);
        if (!udoc.hasPerm(PERM.PERM_CREATE_PROBLEM)) {
            throw new PermissionError(PERM.PERM_CREATE_PROBLEM);
        }
        if (!this.pdoc.data) {
            // Copy Without Data
            pid = await problem.add(
                destDomainId, this.pdoc.pid, this.pdoc.title,
                this.pdoc.content, this.user._id, this.pdoc.tag,
                this.pdoc.category, null, hidden,
            );
        } else if (this.pdoc.data instanceof ObjectID) {
            // With data
            pid = await problem.add(
                destDomainId, this.pdoc.pid, this.pdoc.title,
                this.pdoc.content, this.user._id, this.pdoc.tag,
                this.pdoc.category, { domainId, pid }, hidden,
            );
        } else {
            // TODO better message
            // Data should only be copied once.
            throw new BadRequestError('Cannot copy this problem.');
        }
        this.response.redirect = this.url('problem_settings', { domainId: destDomainId, pid });
    }

    @param('pid', Types.UnsignedInt)
    async postRejudge(domainId: string, pid: number) {
        this.checkPerm(PERM.PERM_REJUDGE_PROBLEM);
        // TODO maybe async?
        await record.getMulti(domainId, { pid }).forEach(async (doc) => {
            await record.reset(domainId, doc._id, true);
            await record.judge(domainId, doc._id, -1);
        });
        this.back();
    }
}

export class ProblemExportHandler extends ProblemDetailHandler {
    async get() {
        const hasPerm = (this.user._id === this.pdoc.owner && this.user.hasPerm(PERM.PERM_READ_PROBLEM_DATA_SELF))
            || this.user.hasPerm(PERM.PERM_READ_PROBLEM_DATA_SELF);
        const pdoc = pick(this.pdoc, ['pid', 'acMsg', 'content', 'config', 'title', 'html', 'tag', 'category']);
        let zip: AdmZip;
        if (hasPerm) {
            if (this.pdoc.data instanceof ObjectID) {
                const buf = await streamToBuffer(await file.get(this.pdoc.data));
                zip = new AdmZip(buf);
            } else zip = new AdmZip();
        } else zip = new AdmZip();
        zip.addFile('problem.json', Buffer.from(JSON.stringify(pdoc)));
        this.response.attachment(`${this.pdoc.title}.zip`, zip.toBuffer());
    }
}

export class ProblemSubmitHandler extends ProblemDetailHandler {
    @param('pid', Types.String, null, parsePid)
    async get(domainId: string, pid: string | number) {
        this.response.template = 'problem_submit.html';
        const rdocs = await record
            .getUserInProblemMulti(domainId, this.user._id, this.pdoc.docId)
            .sort({ _id: -1 })
            .limit(10)
            .toArray();
        this.response.body = {
            path: [
                ['Hydro', 'homepage'],
                ['problem_main', 'problem_main'],
                [this.pdoc.title, 'problem_detail', { pid }, true],
                ['problem_submit', null],
            ],
            pdoc: this.pdoc,
            udoc: this.udoc,
            rdocs,
            title: this.pdoc.title,
        };
    }

    @param('lang', Types.String)
    @param('code', Types.String)
    async post(domainId: string, lang: string, code: string) {
        const rid = await record.add(domainId, this.pdoc.docId, this.user._id, lang, code, true);
        const [rdoc] = await Promise.all([
            record.get(domainId, rid),
            problem.inc(domainId, this.pdoc.docId, 'nSubmit', 1),
            domain.incUserInDomain(domainId, this.user._id, 'nSubmit'),
        ]);
        bus.boardcast('record/change', rdoc);
        this.response.body = { rid };
        this.response.redirect = this.url('record_detail', { rid });
    }
}

export class ProblemPretestHandler extends ProblemDetailHandler {
    @param('lang', Types.String)
    @param('code', Types.String)
    @param('input', Types.String, true)
    async post(domainId: string, lang: string, code: string, input: string = '') {
        this.limitRate('add_record', 3600, 100);
        // TODO parseConfig
        const rid = await record.add(
            domainId, this.pdoc.docId, this.user._id,
            lang, code, true,
            {
                input,
                time: '1s',
                memory: '256m',
            },
        );
        const rdoc = await record.get(domainId, rid);
        bus.boardcast('record/change', rdoc);
        this.response.body = { rid };
    }
}

export class ProblemPretestConnectionHandler extends ConnectionHandler {
    pid: string;

    domainId: string;

    dispose: bus.Disposable;

    @param('pid', Types.String)
    async prepare(domainId: string, pid: string) {
        const pdoc = await problem.get(domainId, pid);
        if (!pdoc) throw new ProblemNotFoundError(domainId, pid);
        if (pdoc.hidden) this.checkPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN);
        this.pid = pdoc.docId.toString();
        this.domainId = domainId;
        this.dispose = bus.on('record/change', this.onRecordChange.bind(this));
    }

    async onRecordChange(rdoc: Rdoc) {
        if (
            rdoc.uid !== this.user._id
            || rdoc.pid.toString() !== this.pid
            || rdoc.domainId !== this.domainId
        ) return;
        rdoc.compilerTexts = [];
        rdoc.judgeTexts = [];
        // @ts-ignore
        rdoc.testCases = rdoc.testCases.map((c) => ({
            status: c.status,
        }));
        // TODO handle update
        if (rdoc.contest) return;
        this.send({ rdoc });
    }

    async cleanup() {
        if (this.dispose) this.dispose();
    }
}

export class ProblemStatisticsHandler extends ProblemDetailHandler {
    async get(domainId: string) {
        const udoc = await user.getById(domainId, this.pdoc.owner);
        const path = [
            ['problem_main', 'problem_main'],
            [this.pdoc.title, 'problem_detail', { pid: this.pdoc.pid }, true],
            ['problem_statistics', null],
        ];
        this.response.template = 'problem_statistics.html';
        this.response.body = { pdoc: this.pdoc, udoc, path };
    }
}

export class ProblemManageHandler extends ProblemDetailHandler {
    async prepare() {
        if (this.pdoc.owner !== this.user._id) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
        else this.checkPerm(PERM.PERM_EDIT_PROBLEM_SELF);
    }
}

export class ProblemSettingsHandler extends ProblemManageHandler {
    @param('pid', Types.String)
    async get(domainId: string, pid: string) {
        this.response.template = 'problem_settings.html';
        this.response.body.path = [
            ['Hydro', 'homepage'],
            ['problem_main', 'problem_main'],
            [this.pdoc.title, 'problem_detail', { pid }, true],
            ['problem_settings', null],
        ];
        if (this.response.body.pdoc.config) {
            this.response.body.pdoc.config = yaml.safeDump(this.response.body.pdoc.config);
        }
    }

    @param('pid', Types.String, null, parsePid)
    @param('yaml', Types.String)
    async postConfig(domainId: string, pid: string | number, cfg: string) {
        const pdoc = await problem.get(domainId, pid);
        // TODO validate
        const config = yaml.safeLoad(cfg) as any;
        await problem.edit(domainId, pdoc.docId, { config });
        this.back();
    }

    @param('pid', Types.String, null, parsePid)
    @param('hidden', Types.Boolean)
    @param('category', Types.String, true, null, parseCategory)
    @param('tag', Types.String, true, null, parseCategory)
    @param('difficultySetting', Types.UnsignedInt)
    @param('difficultyAdmin', Types.UnsignedInt, true)
    async postSetting(
        domainId: string, pid: string | number, hidden = false,
        category: string[] = [], tag: string[] = [],
        difficultySetting: string, difficultyAdmin: number,
    ) {
        const pdoc = await problem.get(domainId, pid);
        if (!problem.SETTING_DIFFICULTY_RANGE[difficultySetting]) {
            throw new ValidationError('difficultySetting');
        }
        if (!difficultyAdmin) difficultyAdmin = null;
        else if (difficultyAdmin < 1 || difficultyAdmin > 9) throw new ValidationError('difficultyAdmin');
        const update: Partial<Pdoc> = {
            hidden, category, tag, difficultySetting, difficultyAdmin,
        };
        await bus.serial('problem/setting', update, this);
        await problem.edit(domainId, pdoc.docId, update);
        await global.Hydro.script.difficulty.run({ domainId, pid }, console.log);
        this.back();
    }
}

export class ProblemEditHandler extends ProblemManageHandler {
    async get({ pid }) {
        this.response.template = 'problem_edit.html';
        this.response.body.path = [
            ['Hydro', 'homepage'],
            ['problem_main', 'problem_main'],
            [this.pdoc.title, 'problem_detail', { pid }, true],
            ['problem_edit', null],
        ];
    }

    @param('title', Types.String, isTitle)
    @param('content', Types.String, isContent)
    @post('pid', Types.String, isPid, true)
    async post(domainId: string, title: string, content: string, newPid: string = '') {
        const $update: Partial<Pdoc> = { title, content, pid: newPid };
        let pdoc = await problem.get(domainId, this.request.params.pid);
        pdoc = await problem.edit(domainId, pdoc.docId, $update);
        this.response.redirect = this.url('problem_detail', { pid: pdoc.pid || pdoc.docId });
    }
}

export class ProblemDataUploadHandler extends ProblemManageHandler {
    async get() {
        if (this.pdoc.data instanceof ObjectID) {
            const f = await file.getMeta(this.pdoc.data);
            this.response.body.md5 = f.md5;
        } else if (this.pdoc.data) {
            this.response.body.from = this.pdoc.data;
        }
        this.response.template = 'problem_upload.html';
    }

    async post({ domainId }) {
        if (!this.request.files.file) throw new ValidationError('file');
        this.pdoc = await problem.setTestdata(
            domainId, this.pdoc.docId, this.request.files.file.path,
        );
        if (this.pdoc.data instanceof ObjectID) {
            const f = await file.getMeta(this.pdoc.data);
            this.response.body.md5 = f.md5;
        }
        this.response.template = 'problem_upload.html';
    }
}

export class ProblemDataDownloadHandler extends ProblemDetailHandler {
    async get({ pid }) {
        if (!this.user.hasPriv(PRIV.PRIV_JUDGE)) {
            if (this.user._id !== this.pdoc.owner) {
                this.checkPerm(PERM.PERM_READ_PROBLEM_DATA);
            } else this.checkPerm(PERM.PERM_READ_PROBLEM_DATA_SELF);
        }
        if (this.pdoc.data instanceof ObjectID) {
            this.response.redirect = await file.url(this.pdoc.data, `${this.pdoc.title}.zip`);
        } else if (this.pdoc.data) {
            if (!this.pdoc.data.host) {
                this.response.redirect = this.url('problem_data', {
                    domainId: this.pdoc.data.domainId,
                    pid: this.pdoc.data.pid,
                });
            } else {
                const [scheme, raw] = this.pdoc.data.host.split('//');
                const args = JSON.parse(Buffer.from(raw, 'base64').toString());
                if (scheme === 'hydro') {
                    const [secure, host, port, domainId, id] = args;
                    this.response.redirect = `http${secure ? 's' : ''}://${host}:${port}/d/${domainId}/p/${id}/data`;
                } else if (scheme === 'syzoj') {
                    const [secure, host, port, id] = args;
                    this.response.redirect = `http${secure ? 's' : ''}://${host}:${port}/problem/${id}/testdata/download`;
                } else {
                    throw new ProblemDataNotFoundError(pid);
                }
            }
        } else throw new ProblemDataNotFoundError(pid);
    }
}

export class ProblemSolutionHandler extends ProblemDetailHandler {
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        this.response.template = 'problem_solution.html';
        this.checkPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION);
        const [psdocs, pcount, pscount] = await paginate(
            solution.getMulti(domainId, this.pdoc.docId),
            page,
            CONSTANT.SOLUTION_PER_PAGE,
        );
        const uids = [this.pdoc.owner];
        const docids = [];
        for (const psdoc of psdocs) {
            docids.push(psdoc.docId);
            uids.push(psdoc.owner);
            if (psdoc.reply.length) {
                for (const psrdoc of psdoc.reply) uids.push(psrdoc.owner);
            }
        }
        const udict = await user.getList(domainId, uids);
        const pssdict = solution.getListStatus(domainId, docids, this.user._id);
        const path = [
            ['problem_main', 'problem_main'],
            [this.pdoc.title, 'problem_detail', { pid: this.pdoc.pid }, true],
            ['problem_solution', null],
        ];
        this.response.body = {
            path, psdocs, page, pcount, pscount, udict, pssdict, pdoc: this.pdoc,
        };
    }

    @param('content', Types.String, isContent)
    async postSubmit(domainId: string, content: string) {
        this.checkPerm(PERM.PERM_CREATE_PROBLEM_SOLUTION);
        await solution.add(domainId, this.pdoc.docId, this.user._id, content);
        this.back();
    }

    @param('content', Types.String, isContent)
    @param('psid', Types.ObjectID)
    async postEditSolution(domainId: string, content: string, psid: ObjectID) {
        let psdoc = await solution.get(domainId, psid);
        if (psdoc.owner !== this.user._id) this.checkPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION);
        else this.checkPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION_SELF);
        psdoc = await solution.edit(domainId, psdoc.docId, content);
        this.back({ psdoc });
    }

    @param('psid', Types.ObjectID)
    async postDeleteSolution(domainId: string, psid: ObjectID) {
        const psdoc = await solution.get(domainId, psid);
        if (psdoc.owner !== this.user._id) this.checkPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION);
        else this.checkPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION_SELF);
        await solution.del(domainId, psdoc.docId);
        this.back();
    }

    @param('psid', Types.ObjectID)
    @param('content', Types.String, isContent)
    async postReply(domainId: string, psid: ObjectID, content: string) {
        this.checkPerm(PERM.PERM_REPLY_PROBLEM_SOLUTION);
        const psdoc = await solution.get(domainId, psid);
        await solution.reply(domainId, psdoc.docId, this.user._id, content);
        this.back();
    }

    @param('psid', Types.ObjectID)
    @param('psrid', Types.ObjectID)
    @param('content', Types.String, isContent)
    async postEditReply(domainId: string, psid: ObjectID, psrid: ObjectID, content: string) {
        const [psdoc, psrdoc] = await solution.getReply(domainId, psid, psrid);
        if ((!psdoc) || psdoc.pid !== this.pdoc.docId) throw new SolutionNotFoundError(psid);
        if (!(psrdoc.owner === this.user._id
            && this.user.hasPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION_REPLY_SELF))) {
            throw new PermissionError(PERM.PERM_EDIT_PROBLEM_SOLUTION_REPLY_SELF);
        }
        await solution.editReply(domainId, psid, psrid, content);
        this.back();
    }

    @param('psid', Types.ObjectID)
    @param('psrid', Types.ObjectID)
    async postDeleteReply(domainId: string, psid: ObjectID, psrid: ObjectID) {
        const [psdoc, psrdoc] = await solution.getReply(domainId, psid, psrid);
        if ((!psdoc) || psdoc.pid !== this.pdoc.docId) throw new SolutionNotFoundError(psid);
        if (!(psrdoc.owner === this.user._id
            && this.user.hasPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION_REPLY_SELF))) {
            this.checkPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION_REPLY);
        }
        await solution.delReply(domainId, psid, psrid);
        this.back();
    }

    @param('psid', Types.ObjectID)
    async postUpvote(domainId: string, psid: ObjectID) {
        const [psdoc, pssdoc] = await solution.vote(domainId, psid, this.user._id, 1);
        this.back({ vote: psdoc.vote, user_vote: pssdoc.vote });
    }

    @param('psid', Types.ObjectID)
    async postDownvote(domainId: string, psid: ObjectID) {
        const [psdoc, pssdoc] = await solution.vote(domainId, psid, this.user._id, -1);
        this.back({ vote: psdoc.vote, user_vote: pssdoc.vote });
    }
}

export class ProblemSolutionRawHandler extends ProblemDetailHandler {
    @param('psid', Types.ObjectID)
    async get(domainId: string, psid: ObjectID) {
        this.checkPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION);
        const psdoc = await solution.get(domainId, psid);
        this.response.type = 'text/markdown';
        this.response.body = psdoc.content;
    }
}

export class ProblemSolutionReplyRawHandler extends ProblemDetailHandler {
    @param('psid', Types.ObjectID)
    @param('psrid', Types.ObjectID)
    async get(domainId: string, psid: ObjectID, psrid: ObjectID) {
        this.checkPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION);
        const [psdoc, psrdoc] = await solution.getReply(domainId, psid, psrid);
        if ((!psdoc) || psdoc.pid !== this.pdoc.docId) throw new SolutionNotFoundError(psid, psrid);
        this.response.type = 'text/markdown';
        this.response.body = psrdoc.content;
    }
}

export class ProblemCreateHandler extends Handler {
    async get() {
        this.response.template = 'problem_edit.html';
        this.response.body = {
            path: [
                ['Hydro', 'homepage'],
                ['problem_main', 'problem_main'],
                ['problem_create', null],
            ],
            page_name: 'problem_create',
        };
    }

    @param('title', Types.String, isTitle)
    @param('pid', Types.String, isPid, true)
    @param('content', Types.String, isContent)
    @param('hidden', Types.Boolean)
    async post(domainId: string, title: string, pid: string, content: string, hidden = false) {
        const docId = await problem.add(
            domainId, pid, title, content,
            this.user._id, [], [], null, hidden,
        );
        this.response.body = { pid: docId };
        this.response.redirect = this.url('problem_settings', { pid: docId });
    }
}

export class ProblemImportHandler extends Handler {
    @param('ufid', Types.ObjectID, true)
    async get(domainId: string, ufid?: ObjectID) {
        if (ufid) {
            const stat = await file.getMeta(ufid);
            if (stat.size > 128 * 1024 * 1024) throw new BadRequestError('File too large');
            const stream = await file.get(ufid);
            const buf = await streamToBuffer(stream);
            const zip = new AdmZip(buf);
            const pdoc = JSON.parse(zip.getEntry('problem.json').getData().toString());
            const pid = await problem.add(domainId, pdoc.pid, pdoc.title, pdoc.content, this.user._id, pdoc.tags, pdoc.category);
            await problem.setTestdata(domainId, pid, buf);
            await problem.edit(domainId, pid, { html: pdoc.html });
            this.response.redirect = this.url('problem_detail', { pid });
            await file.del(ufid);
        } else this.response.template = 'problem_import.html';
    }
}

export async function apply() {
    ProblemAdd('problem_import', {}, 'copy', 'Import From Hydro');
    Route('problem_main', '/p', ProblemMainHandler);
    Route('problem_category', '/p/category/:category', ProblemCategoryHandler);
    Route('problem_random', '/problem/random', ProblemRandomHandler);
    Route('problem_detail', '/p/:pid', ProblemDetailHandler);
    Route('problem_export', '/p/:pid/export', ProblemExportHandler);
    Route('problem_submit', '/p/:pid/submit', ProblemSubmitHandler, PERM.PERM_SUBMIT_PROBLEM);
    Route('problem_pretest', '/p/:pid/pretest', ProblemPretestHandler);
    Route('problem_settings', '/p/:pid/settings', ProblemSettingsHandler);
    Route('problem_statistics', '/p/:pid/statistics', ProblemStatisticsHandler);
    Route('problem_edit', '/p/:pid/edit', ProblemEditHandler);
    Route('problem_upload', '/p/:pid/upload', ProblemDataUploadHandler);
    Route('problem_data', '/p/:pid/data', ProblemDataDownloadHandler);
    Route('problem_solution', '/p/:pid/solution', ProblemSolutionHandler);
    Route('problem_solution_raw', '/p/:pid/solution/:psid/raw', ProblemSolutionRawHandler);
    Route('problem_solution_reply_raw', '/p/:pid/solution/:psid/:psrid/raw', ProblemSolutionReplyRawHandler);
    Route('problem_create', '/problem/create', ProblemCreateHandler, PERM.PERM_CREATE_PROBLEM);
    Route('problem_import', '/problem/import', ProblemImportHandler, PERM.PERM_CREATE_PROBLEM);
    Connection('problem_pretest_conn', '/conn/pretest', ProblemPretestConnectionHandler);
}

global.Hydro.handler.problem = apply;
