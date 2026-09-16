/*global Ultraviolet*/
self.__uv$config = {
	prefix: "/service/",
	encodeUrl: Ultraviolet.codec.xor.encode,
	decodeUrl: Ultraviolet.codec.xor.decode,
	handler: "/ultrav/uv.handler.js",
	client: "/ultrav/uv.client.js",
	bundle: "/ultrav/uv.bundle.js",
	config: "/ultrav/uv.config.js",
	sw: "/ultrav/uv.sw.js",
};
