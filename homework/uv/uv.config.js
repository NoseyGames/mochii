
self.__uv$config = {
    prefix: '/homework/uv/service/',

    bare: [
        'https://bare.benrogo.net/',
        'https://solitary-haze-aa1f.projectorsum.workers.dev/',
        'https://bare.deno.dev/',
        'https://uv.testingcf.workers.dev/',
        'https://bare.rocks/'
    ],
    
    encodeUrl: Ultraviolet.codec.xor.encode,
    decodeUrl: Ultraviolet.codec.xor.decode,
    handler: '/homework/uv/uv.handler.js',
    client: '/homework/uv/uv.client.js',
    bundle: '/homework/uv/uv.bundle.js',
    config: '/homework/uv/uv.config.js',
    sw: '/homework/uv/uv.sw.js',
};
