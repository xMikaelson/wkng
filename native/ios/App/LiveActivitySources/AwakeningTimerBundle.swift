import WidgetKit
import SwiftUI

/// Punto d'ingresso dell'estensione AwakeningTimer: contiene solo la Live
/// Activity del recupero. La destinazione minima dell'estensione e' iOS 16.2.
@main
struct AwakeningTimerBundle: WidgetBundle {
    var body: some Widget {
        AwakeningTimerLiveActivity()
    }
}
