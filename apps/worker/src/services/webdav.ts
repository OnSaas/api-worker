type WebdavCredentials = {
	username: string;
	password: string;
};

export type WebdavConfig = {
	baseUrl: string;
	path: string;
	credentials: WebdavCredentials;
};

type WebdavRequestOptions = {
	method: string;
	body?: string;
	headers?: Record<string, string>;
};

const trimSlashes = (value: string) => value.replace(/^\/+|\/+$/g, "");

const encodeAuth = (username: string, password: string): string => {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
};

const authHeader = (credentials: WebdavCredentials) =>
	`Basic ${encodeAuth(credentials.username, credentials.password)}`;

const normalizeBaseUrl = (value: string): string => {
	const trimmed = value.trim();
	if (!trimmed) {
		return "";
	}
	return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
};

const splitSegments = (value: string): string[] =>
	trimSlashes(value)
		.split("/")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);

const buildUrl = (baseUrl: string, segments: string[]): string => {
	let current = new URL(normalizeBaseUrl(baseUrl));
	for (const segment of segments) {
		current = new URL(`${current.toString()}${encodeURIComponent(segment)}/`);
	}
	return current.toString();
};

const requestWebdav = async (
	config: WebdavConfig,
	segments: string[],
	options: WebdavRequestOptions,
): Promise<Response> => {
	const headers = new Headers(options.headers ?? {});
	headers.set("Authorization", authHeader(config.credentials));
	const url = buildUrl(config.baseUrl, [
		...splitSegments(config.path),
		...segments,
	]);
	return fetch(url, {
		method: options.method,
		headers,
		body: options.body,
	});
};

const ensureDirectory = async (
	config: WebdavConfig,
	relativePath: string,
): Promise<void> => {
	const segments = [
		...splitSegments(config.path),
		...splitSegments(relativePath),
	];
	if (segments.length === 0) {
		return;
	}
	let currentSegments: string[] = [];
	for (const segment of segments) {
		currentSegments = [...currentSegments, segment];
		const response = await requestWebdav(
			{
				...config,
				path: "",
			},
			currentSegments,
			{
				method: "MKCOL",
			},
		);
		if (
			response.status === 201 ||
			response.status === 204 ||
			response.status === 301 ||
			response.status === 302 ||
			response.status === 405 ||
			response.status === 409
		) {
			continue;
		}
		throw new Error(`webdav_mkcol_failed_${response.status}`);
	}
};

const splitParentAndFile = (
	relativeFilePath: string,
): { parentPath: string; fileName: string } => {
	const segments = splitSegments(relativeFilePath);
	if (segments.length === 0) {
		throw new Error("webdav_invalid_relative_path");
	}
	const fileName = segments[segments.length - 1];
	const parentSegments = segments.slice(0, -1);
	return {
		parentPath: parentSegments.join("/"),
		fileName,
	};
};

export async function readWebdavJson<T>(
	config: WebdavConfig,
	relativeFilePath: string,
): Promise<T | null> {
	const segments = splitSegments(relativeFilePath);
	const response = await requestWebdav(config, segments, {
		method: "GET",
		headers: {
			Accept: "application/json",
		},
	});
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		throw new Error(`webdav_get_failed_${response.status}`);
	}
	return (await response.json()) as T;
}

export async function writeWebdavJson(
	config: WebdavConfig,
	relativeFilePath: string,
	payload: unknown,
): Promise<void> {
	const { parentPath, fileName } = splitParentAndFile(relativeFilePath);
	await ensureDirectory(config, parentPath);
	const response = await requestWebdav(
		config,
		[...splitSegments(parentPath), fileName],
		{
			method: "PUT",
			body: JSON.stringify(payload),
			headers: {
				"Content-Type": "application/json",
			},
		},
	);
	if (!response.ok) {
		throw new Error(`webdav_put_failed_${response.status}`);
	}
}

export async function deleteWebdavFile(
	config: WebdavConfig,
	relativeFilePath: string,
): Promise<void> {
	const response = await requestWebdav(
		config,
		splitSegments(relativeFilePath),
		{
			method: "DELETE",
		},
	);
	if (response.status === 404) {
		return;
	}
	if (!response.ok) {
		throw new Error(`webdav_delete_failed_${response.status}`);
	}
}
