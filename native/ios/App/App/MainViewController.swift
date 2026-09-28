import UIKit
import Capacitor

/// Il view controller dell'app: e' quello di Capacitor, con in piu' la
/// registrazione del plugin locale AwakeningLive (non arriva da npm, vive
/// qui nel progetto). Main.storyboard punta a questa classe.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(AwakeningLivePlugin())
    }
}
