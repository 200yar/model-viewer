/*
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {BoxBufferGeometry, CubeCamera, CubeUVReflectionMapping, DoubleSide, LinearToneMapping, Material, Mesh, NearestFilter, NoBlending, OrthographicCamera, PlaneBufferGeometry, Scene, ShaderMaterial, WebGLRenderer, WebGLRenderTarget, WebGLRenderTargetCube} from 'three';

export default class PMREMGenerator {
  private mipmapShader = this.getMipmapShader();
  private packingShader = this.getPackingShader();
  private cubeCamera: CubeCamera|null = null;
  private flatCamera = new OrthographicCamera(-1, 1, 1, -1);
  private mipmapScene = new Scene();
  private packingScene = new Scene();
  private boxMesh = new Mesh(new BoxBufferGeometry(), this.mipmapShader);
  private plane = new PlaneBufferGeometry(1, 1);
  private numLods = -1;
  private cubeLods: Array<WebGLRenderTargetCube>;
  private cubeUVRenderTarget: WebGLRenderTarget|null = null;
  private objects: Array<Mesh>;

  constructor() {
    (this.boxMesh.material as Material).side = DoubleSide;
    this.mipmapScene.add(this.boxMesh);
    this.cubeLods = [];
    this.objects = [];
  }

  update(cubeTarget: WebGLRenderTargetCube, renderer: WebGLRenderer):
      WebGLRenderTarget {
    this.setup(cubeTarget);
    this.generateMipmaps(cubeTarget, renderer);
    this.packMipmaps(renderer);
    return this.cubeUVRenderTarget!;
  }

  setup(cubeTarget: WebGLRenderTargetCube) {
    const size = cubeTarget.width;
    if (this.cubeCamera == null ||
        this.cubeCamera.renderTarget.width !== size) {
      this.cubeCamera = new CubeCamera(0.1, 100, size);
    }
    this.mipmapScene.add(this.cubeCamera);

    const params = {
      format: cubeTarget.texture.format,
      magFilter: NearestFilter,
      minFilter: NearestFilter,
      type: cubeTarget.texture.type,
      generateMipmaps: false,
      anisotropy: cubeTarget.texture.anisotropy,
      encoding: cubeTarget.texture.encoding
    };

    // Hard-coded to max faceSize = 256 until we can add a uniform.
    const numLods = 8;
    // how many LODs fit in the given CubeUV Texture.
    // Math.log(size) / Math.log(2) - 2;  // IE11 doesn't support Math.log2

    let offset = 0;
    for (let i = 0; i < numLods + 1; i++) {
      const sizeLod = Math.pow(2, i);
      const sizePad = sizeLod + 2;
      if (this.cubeLods.length <= i) {
        if (sizeLod === size) {
          this.addLodObjects(cubeTarget, offset);
        } else {
          let renderTarget =
              new WebGLRenderTargetCube(sizeLod, sizeLod, params);
          renderTarget.texture.name = 'PMREMGenerator.cube' + i;
          this.cubeLods.push(renderTarget);
          this.addLodObjects(renderTarget, offset);
        }
      }
      offset += 2 * sizePad;
    }

    if (numLods !== this.numLods) {
      this.numLods = numLods;
      this.cubeUVRenderTarget = new WebGLRenderTarget(
          3 * (Math.pow(2, numLods) + 2),
          4 * numLods + 2 * (Math.pow(2, numLods + 1) - 1),
          params);
      this.cubeUVRenderTarget.texture.name = 'PMREMCubeUVPacker.cubeUv';
      this.cubeUVRenderTarget.texture.mapping = CubeUVReflectionMapping;
      this.flatCamera.left = 0;
      this.flatCamera.right = this.cubeUVRenderTarget.width;
      this.flatCamera.top = 0;
      this.flatCamera.bottom = this.cubeUVRenderTarget.height;
      this.flatCamera.near = 0;
      this.flatCamera.far = 1;
      this.flatCamera.updateProjectionMatrix();
    }
  }

  addLodObjects(target: WebGLRenderTargetCube, offset: number) {
    const sizeLod = target.width;
    const sizePad = sizeLod + 2;
    const invSize = 1.0 / sizeLod;
    const plane = this.plane.clone();
    const uv = (plane.attributes.uv.array as Array<number>);
    for (let j = 0; j < uv.length; j++) {
      if (uv[j] === 0) {
        uv[j] = -invSize;
      } else if (uv[j] === 1) {
        uv[j] = 1 + invSize;
      } else {
        console.error('unexpected UV coordiante ' + uv);
      }
    }
    for (let k = 0; k < 6; k++) {
      // 6 Cube Faces
      let material = this.packingShader.clone();
      material.uniforms['invMapSize'].value = invSize;
      material.uniforms['envMap'].value = target.texture;
      material.uniforms['faceIndex'].value = k;

      let planeMesh = new Mesh(plane, material);

      planeMesh.position.x = (k % 3) * sizePad;
      planeMesh.position.y = (k > 2 ? 1 : 0) * sizePad + offset;
      (planeMesh.material as Material).side = DoubleSide;
      planeMesh.scale.setScalar(sizePad);
      this.objects.push(planeMesh);
    }
  }

  generateMipmaps(cubeTarget: WebGLRenderTargetCube, renderer: WebGLRenderer) {
    var gammaInput = renderer.gammaInput;
    var gammaOutput = renderer.gammaOutput;
    var toneMapping = renderer.toneMapping;
    var toneMappingExposure = renderer.toneMappingExposure;
    var currentRenderTarget = renderer.getRenderTarget();

    renderer.toneMapping = LinearToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.gammaInput = false;
    renderer.gammaOutput = false;

    this.mipmapShader.uniforms['invMapSize'].value = 1.0 / cubeTarget.width;
    this.mipmapShader.uniforms['envMap'].value = cubeTarget.texture;
    for (let i = this.numLods - 1; i >= 0; i--) {
      renderer.setRenderTarget(this.cubeLods[i]);
      this.cubeCamera!.update(renderer, this.mipmapScene);
      this.mipmapShader.uniforms['invMapSize'].value =
          1.0 / this.cubeLods[i].width;
      this.mipmapShader.uniforms['envMap'].value = this.cubeLods[i].texture;
    }

    renderer.setRenderTarget(currentRenderTarget);
    renderer.toneMapping = toneMapping;
    renderer.toneMappingExposure = toneMappingExposure;
    renderer.gammaInput = gammaInput;
    renderer.gammaOutput = gammaOutput;
  }

  packMipmaps(renderer: WebGLRenderer) {
    for (let i = 0; i < 6 * this.numLods; i++) {
      this.packingScene.add(this.objects[i]);
    }

    var gammaInput = renderer.gammaInput;
    var gammaOutput = renderer.gammaOutput;
    var toneMapping = renderer.toneMapping;
    var toneMappingExposure = renderer.toneMappingExposure;
    var currentRenderTarget = renderer.getRenderTarget();

    renderer.gammaInput = false;
    renderer.gammaOutput = false;
    renderer.toneMapping = LinearToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.setRenderTarget(this.cubeUVRenderTarget);
    renderer.render(this.packingScene, this.flatCamera);

    renderer.setRenderTarget(currentRenderTarget);
    renderer.toneMapping = toneMapping;
    renderer.toneMappingExposure = toneMappingExposure;
    renderer.gammaInput = gammaInput;
    renderer.gammaOutput = gammaOutput;

    for (let i = 0; i < 6 * this.numLods; i++) {
      this.packingScene.remove(this.objects[i]);
    }
  }

  getMipmapShader() {
    var shaderMaterial = new ShaderMaterial({

      uniforms: {'invMapSize': {value: 0.5}, 'envMap': {value: null}},

      vertexShader: `
varying vec2 vUv;
varying vec3 vPosition;
void main() {
    vUv = uv;
    vPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`,

      fragmentShader: `
#include <common>
varying vec2 vUv;
varying vec3 vPosition;
uniform float invMapSize;
uniform samplerCube envMap;
int getFace(vec3 direction) {
    vec3 absDirection = abs(direction);
    int face = -1;
    if (absDirection.x > absDirection.z) {
      if (absDirection.x > absDirection.y)
        face = direction.x > 0.0 ? 0 : 3;
      else
        face = direction.y > 0.0 ? 1 : 4;
    } else {
      if (absDirection.z > absDirection.y)
        face = direction.z > 0.0 ? 2 : 5;
      else
        face = direction.y > 0.0 ? 1 : 4;
    }
    return face;
}
vec3 getDirection(vec2 uv, int face) {
    uv = 2.0 * uv - 1.0;
    vec3 direction;
    if (face == 0) {
      direction = vec3(1.0, uv);
    } else if (face == 1) {
      direction = vec3(uv.x, 1.0, uv.y);
    } else if (face == 2) {
      direction = vec3(uv, 1.0);
    } else if (face == 3) {
      direction = vec3(-1.0, uv);
    } else if (face == 4) {
      direction = vec3(uv.x, -1.0, uv.y);
    } else {
      direction = vec3(uv, -1.0);
    }
    return direction;
}
void main() {
  int face = getFace(vPosition);
  vec2 uv = vUv - 0.5 * invMapSize;
  vec3 texelDir = getDirection(uv, face);
  vec3 color = envMapTexelToLinear(textureCube(envMap, texelDir)).rgb;
  uv.x += invMapSize;
  texelDir = getDirection(uv, face);
  color += envMapTexelToLinear(textureCube(envMap, texelDir)).rgb;
  uv.y += invMapSize;
  texelDir = getDirection(uv, face);
  color += envMapTexelToLinear(textureCube(envMap, texelDir)).rgb;
  uv.x -= invMapSize;
  texelDir = getDirection(uv, face);
  color += envMapTexelToLinear(textureCube(envMap, texelDir)).rgb;
  gl_FragColor = linearToOutputTexel(vec4(color * 0.25, 1.0));
}
`,

      blending: NoBlending

    });

    shaderMaterial.type = 'PMREMGenerator';

    return shaderMaterial;
  }

  getPackingShader() {
    var shaderMaterial = new ShaderMaterial({

      uniforms: {
        'invMapSize': {value: 0.5},
        'envMap': {value: null},
        'faceIndex': {value: 0},
      },

      vertexShader: `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`,

      fragmentShader: `
varying vec2 vUv;
uniform float invMapSize;
uniform samplerCube envMap;
uniform int faceIndex;
vec3 getDirection(vec2 uv, int face) {
    uv = 2.0 * uv - 1.0;
    vec3 direction;
    if (face == 0) {
      direction = vec3(1.0, uv);
    } else if (face == 1) {
      direction = vec3(uv.x, 1.0, uv.y);
    } else if (face == 2) {
      direction = vec3(uv, 1.0);
    } else if (face == 3) {
      direction = vec3(-1.0, uv);
    } else if (face == 4) {
      direction = vec3(uv.x, -1.0, uv.y);
    } else {
      direction = vec3(uv, -1.0);
    }
    return direction;
}
void main() {
    if ((vUv.x >= 0.0 && vUv.x <= 1.0) || (vUv.y >= 0.0 && vUv.y <= 1.0)) {
      vec3 direction = getDirection(vUv, faceIndex);
      gl_FragColor = textureCube(envMap, direction);
    } else {
      vec2 uv = vUv;
      uv.x += vUv.x < 0.0 ? invMapSize : -invMapSize;
      vec3 direction = getDirection(uv, faceIndex);
      vec3 color = envMapTexelToLinear(textureCube(envMap, direction)).rgb;
      uv.y += vUv.y < 0.0 ? invMapSize : -invMapSize;
      direction = getDirection(uv, faceIndex);
      color += envMapTexelToLinear(textureCube(envMap, direction)).rgb;
      uv.x += vUv.x < 0.0 ? invMapSize : -invMapSize;
      direction = getDirection(uv, faceIndex);
      color += envMapTexelToLinear(textureCube(envMap, direction)).rgb;
      gl_FragColor = linearToOutputTexel(vec4(color / 3.0, 1.0));
    }
}
`,

      blending: NoBlending

    });

    shaderMaterial.type = 'PMREMCubeUVPacker';

    return shaderMaterial;
  }
}