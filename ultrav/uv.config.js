self.__uv$config = {
  prefix: '/service/',
  bare: 'https://bare.benrovers.nl/', // or your worker URL
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: '/ultrav/uv.handler.js',
  bundle: '/ultrav/uv.bundle.js',
  config: '/ultrav/uv.config.js',
  sw: '/sw.js',
};
