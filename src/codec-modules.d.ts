// Type declarations for the DICOM decoder packages (they ship without types).
declare module 'jpeg-lossless-decoder-js' {
  export class Decoder {
    decode(buffer: ArrayBuffer, offset?: number, length?: number, numBytes?: number): Uint8Array | Uint16Array;
  }
}
declare module '@cornerstonejs/codec-charls/decodewasmjs' {
  const factory: unknown;
  export default factory;
}
declare module '@cornerstonejs/codec-openjpeg/decodewasmjs' {
  const factory: unknown;
  export default factory;
}
declare module '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs' {
  const factory: unknown;
  export default factory;
}
declare module '*?url' {
  const url: string;
  export default url;
}
