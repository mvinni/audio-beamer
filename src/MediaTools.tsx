import { useEffect, useState } from "react";
import groupBy from "lodash/groupBy";

interface SimpleIOList {
  /** quaranteed unique */
  uuid: string,
  groupId: string,
  /** may be re-used in another groupId  */
  id: string,
  label: string,
}

/// 'hasLocalMicAccess' is mainly used to trigger a new query of the devices
function useEnumerateMediaDevices(hasLocalMicAccess: boolean) {

  const [audioIns, setAudioIns] = useState<Array<SimpleIOList>>([]);
  const [audioOuts, setAudioOuts] = useState<Array<SimpleIOList>>([]);
  const [videoIns, setVideoIns] = useState<Array<SimpleIOList>>([]);
  const [hasLabels, setHasLabels] = useState<boolean>(false);

  const updateToggle = hasLocalMicAccess || hasLabels;

  useEffect(() => {
    let mounted = true;

    const onChange = () => {
      navigator.mediaDevices.enumerateDevices()
        .then(gotDevices)
        .catch((err) => {
          console.error("Error enumerating devices: ", err);
        });

      function gotDevices(deviceInfos: MediaDeviceInfo[]) {
        const audioInputs: SimpleIOList[] = [];
        const audioOutputs: SimpleIOList[] = [];
        const videoInputs: SimpleIOList[] = [];
        let seenLabels = false;

        const splitByKind = groupBy(deviceInfos, 'kind');

        function assignLabelsByGroup(
              target: SimpleIOList[],
              from: MediaDeviceInfo[],
              defaultLabel: string) {

          if (!from) {
            return;
          }

          for (var i = 0; i !== from.length; ++i) {
            var deviceInfo = from[i];

            target.push({
              groupId: deviceInfo.groupId,
              id: deviceInfo.deviceId,
              uuid: JSON.stringify({ g: deviceInfo.groupId, d: deviceInfo.deviceId }),
              label: deviceInfo.label ||
                `${defaultLabel} ${target.length + 1}`,
            });

            seenLabels = seenLabels || (!!deviceInfo.label);
          }
        }

        assignLabelsByGroup(audioInputs, splitByKind['audioinput'], 'Microphone');
        assignLabelsByGroup(audioOutputs, splitByKind['audiooutput'], 'Speaker');
        assignLabelsByGroup(videoInputs, splitByKind['videoinput'], 'Camera');

        console.log(`Enumerated
            ${audioInputs.length} audio inputs,
            ${audioOutputs.length} audio outputs,
            ${videoInputs.length} video inputs.
            With labels? ${seenLabels}`);

        if (!mounted) {
          return;
        }

        setAudioIns(audioInputs);
        setAudioOuts(audioOutputs);
        setVideoIns(videoInputs);
        setHasLabels(seenLabels);
      }
    };

    onChange();
    navigator.mediaDevices.addEventListener('devicechange', onChange);

    return () => {
      mounted = false;
      navigator.mediaDevices.removeEventListener('devicechange', onChange);
    }
  }, [updateToggle]);

  return {
    audioIns,
    audioOuts,
    videoIns,
  };
}

export { useEnumerateMediaDevices };

/**
 * micUUID should be from SimpleIOList.uuid (proper JSON)
 */
const getLocalAudioStream = async (micUUID?: string) => {
  let deviceId = undefined;
  let groupId = undefined;
  if (micUUID) {
    const ids = JSON.parse(micUUID);
    groupId = ids.g;
    deviceId = ids.d;
  }

  try {
    let stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        autoGainControl: false,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,

        deviceId: deviceId,
        groupId: groupId
      }
    });
    return stream;
  } catch(err) {
    console.error('getting local audio failed: ', err);
    return null;
  }
};

export { getLocalAudioStream };

const resumeAudioContext = (audioCtx: AudioContext | null) => {
  if (audioCtx) {
    // 'interrupted' is from MDN samples for iOS Safari
    // @ts-ignore
    if (audioCtx.state === 'interrupted' || audioCtx.state === 'suspended') {
      console.log('Old AudioContext.state = ', audioCtx.state);
      audioCtx.resume().then(() => console.log('New AudioContext.state = ', audioCtx.state));
    }
  }
};
export { resumeAudioContext };
