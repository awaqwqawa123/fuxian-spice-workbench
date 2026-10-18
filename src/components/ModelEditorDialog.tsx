import { createPortal } from 'react-dom'
import ModelEditor, { type ModelEditorProps } from './ModelEditor'

export type ModelEditorDialogProps = Omit<ModelEditorProps, 'embedded' | 'active'>

/** Mount while open. Sidebar rerenders preserve the draft; choosing a new target starts a new edit. */
export default function ModelEditorDialog(props: ModelEditorDialogProps) {
  const targetKey = props.deviceId ? `device:${props.deviceId}` : `model:${props.modelId}`
  return createPortal(<ModelEditor key={targetKey} {...props}/>, document.body)
}
