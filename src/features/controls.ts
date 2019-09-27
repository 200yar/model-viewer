/* @license
 * Copyright 2019 Google LLC. All Rights Reserved.
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

import {property} from 'lit-element';
import {Event, PerspectiveCamera, Spherical, Vector3} from 'three';

import {style} from '../decorators.js';
import ModelViewerElementBase, {$ariaLabel, $loadedTime, $needsRender, $onModelLoad, $onResize, $scene, $tick} from '../model-viewer-base.js';
import {normalizeUnit} from '../styles/conversions.js';
import {EvaluatedStyle, Intrinsics, SphericalIntrinsics, Vector3Intrinsics} from '../styles/evaluators.js';
import {IdentNode, NumberNode, numberNode, parseExpressions} from '../styles/parsers.js';
import {DEFAULT_FOV_DEG} from '../three-components/Model.js';
import {ChangeEvent, ChangeSource, SmoothControls} from '../three-components/SmoothControls.js';
import {Constructor} from '../utilities.js';

export interface CameraChangeDetails {
  source: ChangeSource;
}

export interface SphericalPosition {
  theta: number;  // equator angle around the y (up) axis.
  phi: number;    // polar angle from the y (up) axis.
  radius: number;
}

export type InteractionPromptStrategy = 'auto'|'when-focused'|'none';
export type InteractionPolicy = 'always-allow'|'allow-when-focused';

const InteractionPromptStrategy:
    {[index: string]: InteractionPromptStrategy} = {
      AUTO: 'auto',
      WHEN_FOCUSED: 'when-focused',
      NONE: 'none'
    };

const InteractionPolicy: {[index: string]: InteractionPolicy} = {
  ALWAYS_ALLOW: 'always-allow',
  WHEN_FOCUSED: 'allow-when-focused'
};

export const DEFAULT_CAMERA_ORBIT = '0deg 75deg 105%';
const DEFAULT_CAMERA_TARGET = 'auto auto auto';
const DEFAULT_FIELD_OF_VIEW = 'auto';

export const fieldOfViewIntrinsics = {
  basis: [numberNode(DEFAULT_FOV_DEG * Math.PI / 180, 'rad')],
  keywords: {auto: [null]}
};

export const cameraOrbitIntrinsics = (() => {
  const defaultTerms =
      parseExpressions(DEFAULT_CAMERA_ORBIT)[0]
          .terms as [NumberNode<'rad'>, NumberNode<'rad'>, IdentNode];

  const theta = normalizeUnit(defaultTerms[0]) as NumberNode<'rad'>;
  const phi = normalizeUnit(defaultTerms[1]) as NumberNode<'rad'>;

  return (element: ModelViewerElementBase) => {
    const radius = element[$scene].model.idealCameraDistance;

    return {
      basis: [theta, phi, numberNode(radius, 'm')],
      keywords: {auto: [null, null, numberNode(105, '%')]}
    };
  };
})();

export const cameraTargetIntrinsics = (element: ModelViewerElementBase) => {
  const center = element[$scene].model.boundingBox.getCenter(new Vector3);

  return {
    basis: [
      numberNode(center.x, 'm'),
      numberNode(center.y, 'm'),
      numberNode(center.z, 'm')
    ],
    keywords: {auto: [null, null, null]}
  };
};

const HALF_FIELD_OF_VIEW_RADIANS = (DEFAULT_FOV_DEG / 2) * Math.PI / 180;
const HALF_PI = Math.PI / 2.0;
const THIRD_PI = Math.PI / 3.0;
const QUARTER_PI = HALF_PI / 2.0;
const PHI = 2.0 * Math.PI;

const AZIMUTHAL_QUADRANT_LABELS = ['front', 'right', 'back', 'left'];
const POLAR_TRIENT_LABELS = ['upper-', '', 'lower-'];

export const DEFAULT_INTERACTION_PROMPT_THRESHOLD = 3000;
export const INTERACTION_PROMPT =
    'Use mouse, touch or arrow keys to control the camera!';

export const $controls = Symbol('controls');
export const $promptElementSVG = Symbol('promptElementSVG');
export const $promptElement = Symbol('promptElement');
export const $idealCameraDistance = Symbol('idealCameraDistance');
const $framedFieldOfView = Symbol('framedFieldOfView');

const $deferInteractionPrompt = Symbol('deferInteractionPrompt');
const $updateAria = Symbol('updateAria');
const $updateCamera = Symbol('updateCamera');

const $blurHandler = Symbol('blurHandler');
const $focusHandler = Symbol('focusHandler');
const $changeHandler = Symbol('changeHandler');

const $onBlur = Symbol('onBlur');
const $onFocus = Symbol('onFocus');
const $onChange = Symbol('onChange');

const $shouldPromptUserToInteract = Symbol('shouldPromptUserToInteract');
const $waitingToPromptUser = Symbol('waitingToPromptUser');
const $userPromptedOnce = Symbol('userPromptedOnce');
const $promptElementVisible = Symbol('promptElementVisible');

const $lastSpherical = Symbol('lastSpherical');
const $jumpCamera = Symbol('jumpCamera');

const $syncCameraOrbit = Symbol('syncCameraOrbit');
const $syncFieldOfView = Symbol('syncFieldOfView');
const $syncCameraTarget = Symbol('syncCameraTarget');

export interface ControlsInterface {
  cameraControls: boolean;
  cameraOrbit: string;
  cameraTarget: string;
  fieldOfView: string;
  interactionPrompt: InteractionPromptStrategy;
  interactionPolicy: InteractionPolicy;
  interactionPromptThreshold: number;
  getCameraOrbit(): SphericalPosition;
  getCameraTarget(): Vector3;
  getFieldOfView(): number;
  jumpCameraToGoal(): void;
}

export const ControlsMixin = <T extends Constructor<ModelViewerElementBase>>(
    ModelViewerElement: T): Constructor<ControlsInterface>&T => {
  class ControlsModelViewerElement extends ModelViewerElement {
    @property({type: Boolean, attribute: 'camera-controls'})
    cameraControls: boolean = false;

    @style({
      intrinsics: cameraOrbitIntrinsics,
      observeEffects: true,
      updateHandler: $syncCameraOrbit
    })
    @property({type: String, attribute: 'camera-orbit', hasChanged: () => true})
    cameraOrbit: string = DEFAULT_CAMERA_ORBIT;

    @style({
      intrinsics: cameraTargetIntrinsics,
      observeEffects: true,
      updateHandler: $syncCameraTarget
    })
    @property(
        {type: String, attribute: 'camera-target', hasChanged: () => true})
    cameraTarget: string = DEFAULT_CAMERA_TARGET;

    @style({
      intrinsics: fieldOfViewIntrinsics,
      observeEffects: true,
      updateHandler: $syncFieldOfView
    })
    @property(
        {type: String, attribute: 'field-of-view', hasChanged: () => true})
    fieldOfView: string = DEFAULT_FIELD_OF_VIEW;

    @property({type: Number, attribute: 'interaction-prompt-threshold'})
    interactionPromptThreshold: number = DEFAULT_INTERACTION_PROMPT_THRESHOLD;

    @property({type: String, attribute: 'interaction-prompt'})
    interactionPrompt: InteractionPromptStrategy =
        InteractionPromptStrategy.AUTO;

    @property({type: String, attribute: 'interaction-policy'})
    interactionPolicy: InteractionPolicy = InteractionPolicy.ALWAYS_ALLOW;

    protected[$promptElement] =
        this.shadowRoot!.querySelector('.controls-prompt')!;
    protected[$promptElementSVG] =
        this.shadowRoot!.querySelector('.controls-prompt svg')!;

    protected[$promptElementVisible] = false;
    protected[$userPromptedOnce] = false;
    protected[$waitingToPromptUser] = false;
    protected[$shouldPromptUserToInteract] = true;

    protected[$controls] = new SmoothControls(
        this[$scene].getCamera() as PerspectiveCamera, this[$scene].canvas);

    protected[$framedFieldOfView]: number|null = null;
    protected[$lastSpherical] = new Spherical();
    protected[$jumpCamera] = false;

    protected[$changeHandler] = (event: Event) =>
        this[$onChange](event as ChangeEvent);

    protected[$focusHandler] = () => this[$onFocus]();
    protected[$blurHandler] = () => this[$onBlur]();

    getCameraOrbit(): SphericalPosition {
      const {theta, phi, radius} = this[$lastSpherical];
      return {theta, phi, radius};
    }

    getCameraTarget(): Vector3 {
      return this[$controls].getTarget();
    }

    getFieldOfView(): number {
      return this[$controls].getFieldOfView();
    }

    jumpCameraToGoal() {
      this[$jumpCamera] = true;
      this.requestUpdate($jumpCamera, false);
    }

    connectedCallback() {
      super.connectedCallback();

      this[$controls].addEventListener('change', this[$changeHandler]);
    }

    disconnectedCallback() {
      super.disconnectedCallback();

      this[$controls].removeEventListener('change', this[$changeHandler]);
    }

    updated(changedProperties: Map<string|number|symbol, unknown>) {
      super.updated(changedProperties as Map<string, any>);

      const controls = this[$controls];
      const scene = (this as any)[$scene];

      if (changedProperties.has('cameraControls')) {
        if (this.cameraControls) {
          controls.enableInteraction();
          if (this.interactionPrompt === InteractionPromptStrategy.AUTO) {
            this[$waitingToPromptUser] = true;
          }

          scene.canvas.addEventListener('focus', this[$focusHandler]);
          scene.canvas.addEventListener('blur', this[$blurHandler]);
        } else {
          scene.canvas.removeEventListener('focus', this[$focusHandler]);
          scene.canvas.removeEventListener('blur', this[$blurHandler]);

          controls.disableInteraction();
          this[$deferInteractionPrompt]();
        }
      }

      if (changedProperties.has('interactionPrompt')) {
        if (this.interactionPrompt === InteractionPromptStrategy.AUTO &&
            this.cameraControls) {
          this[$waitingToPromptUser] = true;
        }
      }

      if (changedProperties.has('interactionPolicy')) {
        const interactionPolicy = this.interactionPolicy;
        controls.applyOptions({interactionPolicy});
      }

      if (changedProperties.has('src')) {
        this[$deferInteractionPrompt]();
        this[$waitingToPromptUser] = true;
      }

      if (this[$jumpCamera] === true) {
        Promise.resolve().then(() => {
          this[$controls].jumpToGoal();
          this[$jumpCamera] = false;
        });
      }
    }

    [$syncFieldOfView](style: EvaluatedStyle<Intrinsics<['rad']>>) {
      this[$controls].setFieldOfView(style[0] * 180 / Math.PI);
    }

    [$syncCameraOrbit](style: EvaluatedStyle<SphericalIntrinsics>) {
      this[$controls].setOrbit(style[0], style[1], style[2]);
    }

    [$syncCameraTarget](style: EvaluatedStyle<Vector3Intrinsics>) {
      const [x, y, z] = style;
      this[$controls].setTarget(x, y, z);
      this[$scene].pivotCenter.set(x, y, z);
      this[$scene].setRotation(this[$scene].pivot.rotation.y);
    }

    [$tick](time: number, delta: number) {
      super[$tick](time, delta);

      if (this[$waitingToPromptUser] &&
          this.interactionPrompt !== InteractionPromptStrategy.NONE) {
        if (this.loaded &&
            time > this[$loadedTime] + this.interactionPromptThreshold) {
          this[$scene].canvas.setAttribute('aria-label', INTERACTION_PROMPT);

          // NOTE(cdata): After notifying users that the controls are
          // available, we flag that the user has been prompted at least
          // once, and then effectively stop the idle timer. If the camera
          // orbit changes after this point, the user will never be prompted
          // again for this particular <model-element> instance:
          this[$userPromptedOnce] = true;
          this[$waitingToPromptUser] = false;
          this[$promptElementVisible] = true;

          this[$promptElement].classList.add('visible');
        }
      }

      if (this[$promptElementVisible]) {
        const modelViewerRect = this.getBoundingClientRect();
        const modelViewerRectCenter =
            modelViewerRect.left + (modelViewerRect.width / 2);
        const promptRect = this[$promptElementSVG].getBoundingClientRect();
        const promptRectCenter = promptRect.left + (promptRect.width / 2);
        const promptOffset = (modelViewerRectCenter) - (promptRectCenter);

        this[$needsRender]();
        (this as any)[$scene].pivot.rotation.y = promptOffset * -0.01;
      }

      this[$controls].update(time, delta);
      const target = this.getCameraTarget();
      if (!this[$scene].pivotCenter.equals(target)) {
        this[$scene].pivotCenter.copy(target);
        this[$scene].setRotation(this[$scene].pivot.rotation.y);
      }
    }

    [$deferInteractionPrompt]() {
      // Effectively cancel the timer waiting for user interaction:
      this[$waitingToPromptUser] = false;
      this[$promptElementVisible] = false;
      this[$promptElement].classList.remove('visible');

      // Implicitly there was some reason to defer the prompt. If the user
      // has been prompted at least once already, we no longer need to
      // prompt the user, although if they have never been prompted we
      // should probably prompt them at least once just in case.
      if (this[$userPromptedOnce]) {
        this[$shouldPromptUserToInteract] = false;
      }
    }

    /**
     * Set the camera's radius and field of view to properly frame the scene
     * based on changes to the model or aspect ratio, and maintains the
     * relative camera zoom state.
     */
    [$updateCamera]() {
      const controls = this[$controls];
      const {aspect} = this[$scene];
      const {idealCameraDistance, fieldOfViewAspect} = this[$scene].model;

      const maximumRadius = idealCameraDistance * 2;
      controls.applyOptions({maximumRadius});

      const modelRadius =
          idealCameraDistance * Math.sin(HALF_FIELD_OF_VIEW_RADIANS);
      const near = 0;
      const far = maximumRadius + modelRadius;

      controls.updateIntrinsics(near, far, aspect);

      if (this.fieldOfView === DEFAULT_FIELD_OF_VIEW) {
        const zoom = (this[$framedFieldOfView] != null) ?
            controls.getFieldOfView() / this[$framedFieldOfView]! :
            1;

        const vertical = Math.tan(HALF_FIELD_OF_VIEW_RADIANS) *
            Math.max(1, fieldOfViewAspect / aspect);
        this[$framedFieldOfView] = 2 * Math.atan(vertical) * 180 / Math.PI;

        const maximumFieldOfView = this[$framedFieldOfView]!;
        controls.applyOptions({maximumFieldOfView});
        controls.setFieldOfView(zoom * this[$framedFieldOfView]!);
      }

      controls.jumpToGoal();
    }

    [$updateAria]() {
      // NOTE(cdata): It is possible that we might want to record the
      // last spherical when the label actually changed. Right now, the
      // side-effect the current implementation is that we will only
      // announce the first view change that occurs after the element
      // becomes focused.
      const {theta: lastTheta, phi: lastPhi} = this[$lastSpherical];
      const {theta, phi} =
          this[$controls]!.getCameraSpherical(this[$lastSpherical]);

      const rootNode = this.getRootNode() as Document | ShadowRoot | null;

      // Only change the aria-label if <model-viewer> is currently focused:
      if (rootNode != null && rootNode.activeElement === this) {
        const lastAzimuthalQuadrant =
            (4 + Math.floor(((lastTheta % PHI) + QUARTER_PI) / HALF_PI)) % 4;
        const azimuthalQuadrant =
            (4 + Math.floor(((theta % PHI) + QUARTER_PI) / HALF_PI)) % 4;

        const lastPolarTrient = Math.floor(lastPhi / THIRD_PI);
        const polarTrient = Math.floor(phi / THIRD_PI);

        if (azimuthalQuadrant !== lastAzimuthalQuadrant ||
            polarTrient !== lastPolarTrient) {
          const {canvas} = (this as any)[$scene];
          const azimuthalQuadrantLabel =
              AZIMUTHAL_QUADRANT_LABELS[azimuthalQuadrant];
          const polarTrientLabel = POLAR_TRIENT_LABELS[polarTrient];

          const ariaLabel =
              `View from stage ${polarTrientLabel}${azimuthalQuadrantLabel}`;

          canvas.setAttribute('aria-label', ariaLabel);
        }
      }
    }

    [$onResize](event: any) {
      super[$onResize](event);
      this[$updateCamera]();
    }

    [$onModelLoad](event: any) {
      super[$onModelLoad](event);
      this[$updateCamera]();
      this.requestUpdate('cameraOrbit', this.cameraOrbit);
      this.requestUpdate('fieldOfView', this.fieldOfView);
      this.requestUpdate('cameraTarget', this.cameraTarget);
      this[$controls].jumpToGoal();
    }

    [$onFocus]() {
      const {canvas} = (this as any)[$scene];

      // NOTE(cdata): On every re-focus, we switch the aria-label back to
      // the original, non-prompt label if appropriate. If the user has
      // already interacted, they no longer need to hear the prompt.
      // Otherwise, they will hear it again after the idle prompt threshold
      // has been crossed.
      const ariaLabel = this[$ariaLabel];

      if (canvas.getAttribute('aria-label') !== ariaLabel) {
        canvas.setAttribute('aria-label', ariaLabel);
      }

      // NOTE(cdata): When focused, if the user has yet to interact with the
      // camera controls (that is, we "should" prompt the user), we begin
      // the idle timer and indicate that we are waiting for it to cross the
      // prompt threshold:
      if (this[$shouldPromptUserToInteract]) {
        this[$waitingToPromptUser] = true;
      }
    }

    [$onBlur]() {
      this[$waitingToPromptUser] = false;
      this[$promptElementVisible] = false;
      this[$promptElement].classList.remove('visible');
    }

    [$onChange]({source}: ChangeEvent) {
      this[$updateAria]();
      this[$needsRender]();

      if (source === ChangeSource.USER_INTERACTION) {
        this[$deferInteractionPrompt]();
      }

      this.dispatchEvent(new CustomEvent<CameraChangeDetails>(
          'camera-change', {detail: {source}}));
    }
  }

  return ControlsModelViewerElement;
};
