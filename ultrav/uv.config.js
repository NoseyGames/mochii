self.__uv$config = {
  prefix: '/service/',
  bare: 'https://bare.mercuryworkshop.com/',
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: '/ultrav/uv.handler.js',
  bundle: '/ultrav/uv.bundle.js',
  config: '/ultrav/uv.config.js',
  sw: '/ultrav/uv.sw.js',
};
