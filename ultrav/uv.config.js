self.__uv$config = {
  prefix: '/service/',
  bare: 'https://bare.benrovers.nl/',
  handler: '/ultrav/uv.handler.js',
  bundle: '/ultrav/uv.bundle.js',
  config: '/ultrav/uv.config.js',
  sw: '/sw.js',
};

// Set codecs after Ultraviolet is available
if (self.Ultraviolet?.codec?.xor) {
  self.__uv$config.encodeUrl = self.Ultraviolet.codec.xor.encode;
  self.__uv$config.decodeUrl = self.Ultraviolet.codec.xor.decode;
}
