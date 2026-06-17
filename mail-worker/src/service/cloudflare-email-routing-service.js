import BizError from '../error/biz-error';
import emailUtils from '../utils/email-utils';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

function parseJsonConfig(value, name) {
	if (!value) return {};
	if (typeof value === 'object') return value;
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new BizError(`${name} must be valid JSON.`);
	}
}

function normalizeEmail(email) {
	return String(email || '').trim().toLowerCase();
}

function ruleToWorker(rule, email, workerName) {
	const matchers = Array.isArray(rule?.matchers) ? rule.matchers : [];
	const actions = Array.isArray(rule?.actions) ? rule.actions : [];
	const hasMatcher = matchers.some(matcher =>
		matcher?.type === 'literal'
		&& matcher?.field === 'to'
		&& normalizeEmail(matcher?.value) === email
	);
	const hasWorkerAction = actions.some(action =>
		action?.type === 'worker'
		&& (!Array.isArray(action?.value) || action.value.includes(workerName))
	);
	return hasMatcher && hasWorkerAction && rule?.enabled === true;
}

const cloudflareEmailRoutingService = {

	getZoneId(c, email) {
		const domain = emailUtils.getDomain(email).toLowerCase();
		const zoneIds = parseJsonConfig(c.env.cf_email_routing_zone_ids, 'cf_email_routing_zone_ids');
		return zoneIds[domain];
	},

	async request(c, zoneId, path, options = {}) {
		const token = c.env.cf_email_routing_api_token;
		if (!token) {
			throw new BizError('Cloudflare Email Routing API Token 未配置，无法自动开通该子域名收件规则。', 502);
		}

		const response = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zoneId}/email/routing${path}`, {
			...options,
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json',
				...(options.headers || {})
			}
		});

		const data = await response.json().catch(() => null);
		if (!response.ok || data?.success === false) {
			const message = data?.errors?.map(error => error.message).filter(Boolean).join('; ')
				|| data?.messages?.map(item => item.message).filter(Boolean).join('; ')
				|| `Cloudflare API request failed with status ${response.status}`;
			throw new BizError(message, response.status >= 500 ? 502 : 501);
		}

		return data;
	},

	async findRule(c, zoneId, email) {
		const data = await this.request(c, zoneId, '/rules?per_page=200', { method: 'GET' });
		const rules = Array.isArray(data?.result) ? data.result : [];
		return rules.find(rule => {
			const matchers = Array.isArray(rule?.matchers) ? rule.matchers : [];
			return matchers.some(matcher =>
				matcher?.type === 'literal'
				&& matcher?.field === 'to'
				&& normalizeEmail(matcher?.value) === email
			);
		});
	},

	async upsertRule(c, zoneId, email) {
		const workerName = c.env.cf_email_routing_worker_name || 'cloud-mail';
		const payload = {
			enabled: true,
			name: `Send ${email} to ${workerName} Worker`,
			matchers: [
				{ type: 'literal', field: 'to', value: email }
			],
			actions: [
				{ type: 'worker', value: [workerName] }
			],
			priority: 0
		};

		const existingRule = await this.findRule(c, zoneId, email);
		if (existingRule) {
			if (ruleToWorker(existingRule, email, workerName)) {
				return existingRule;
			}
			return (await this.request(c, zoneId, `/rules/${existingRule.id}`, {
				method: 'PUT',
				body: JSON.stringify(payload)
			})).result;
		}

		return (await this.request(c, zoneId, '/rules', {
			method: 'POST',
			body: JSON.stringify(payload)
		})).result;
	},

	async ensureRuleForEmail(c, email) {
		email = normalizeEmail(email);
		const zoneId = this.getZoneId(c, email);
		if (!zoneId) return null;

		try {
			return await this.upsertRule(c, zoneId, email);
		} catch (error) {
			const message = String(error?.message || '');
			if (message.toLowerCase().includes('duplicate')) {
				return this.findRule(c, zoneId, email);
			}
			throw error;
		}
	}
};

export default cloudflareEmailRoutingService;
