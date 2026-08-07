// Carrier Share — the macOS share extension (Ref #211).
//
// The share sheet only lists apps that bundle an .appex, so this tiny
// sandboxed extension is what puts Carrier in the menu. It presents no UI:
// every attachment is copied into the app-group inbox, the main app is told
// to take over via carrier://share-inbox/<id>, and the request completes.
// The heavy lifting (validation, size caps, composer delivery) happens in
// the main app, which is the trusted side of this handoff.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

static NSString *const kCarrierAppGroup = @"S5Q742QZEL.io.github.kristofferr.carrier";
static NSString *const kCarrierShareScheme = @"carrier";

@interface CarrierShareViewController : NSViewController <NSExtensionRequestHandling>
@property(atomic) BOOL started;
@property(nonatomic, strong) NSExtensionContext *shareContext;
@end

@implementation CarrierShareViewController

- (void)loadView {
  // Never meaningfully shown; the request is handled from
  // beginRequestWithExtensionContext: (the host may never present this view).
  self.view = [[NSView alloc] initWithFrame:NSZeroRect];
}

- (NSURL *)makeInboxDirectory:(NSString **)outInboxId {
  NSURL *container = [[NSFileManager defaultManager]
      containerURLForSecurityApplicationGroupIdentifier:kCarrierAppGroup];
  if (!container) {
    return nil;
  }
  NSString *inboxId = [[[NSUUID UUID] UUIDString]
      stringByReplacingOccurrencesOfString:@"-"
                                withString:@""]
                          .lowercaseString;
  NSURL *inbox = [[[container URLByAppendingPathComponent:@"Library/Caches/share-inbox"
                                              isDirectory:YES]
      URLByAppendingPathComponent:inboxId
                      isDirectory:YES] URLByStandardizingPath];
  NSError *error = nil;
  if (![[NSFileManager defaultManager] createDirectoryAtURL:inbox
                                withIntermediateDirectories:YES
                                                 attributes:nil
                                                      error:&error]) {
    NSLog(@"Carrier Share: creating inbox failed: %@", error);
    return nil;
  }
  *outInboxId = inboxId;
  return inbox;
}

// A flat, traversal-free file name for one incoming attachment.
- (NSString *)inboxNameForIndex:(NSUInteger)index
                  suggestedName:(NSString *)suggested
                       fallback:(NSString *)fallbackExtension {
  NSString *base = suggested.lastPathComponent;
  if (base.length == 0 || [base hasPrefix:@"."]) {
    base = [NSString stringWithFormat:@"shared-%lu", (unsigned long)index];
    if (fallbackExtension.length > 0) {
      base = [base stringByAppendingPathExtension:fallbackExtension] ?: base;
    }
  }
  return [NSString stringWithFormat:@"%lu-%@", (unsigned long)index, base];
}

// The system calls this on the principal class when the request starts,
// independent of whether the (empty) view is ever presented — presentation
// never happened in practice, so this is the primary entry point.
- (void)beginRequestWithExtensionContext:(NSExtensionContext *)context {
  NSLog(@"Carrier Share: beginRequest");
  self.shareContext = context;
  [self processRequest];
}

// Backup entry in case a macOS release presents the view without calling
// beginRequest on view-controller principals.
- (void)viewDidAppear {
  [super viewDidAppear];
  NSLog(@"Carrier Share: viewDidAppear");
  if (!self.shareContext) {
    self.shareContext = self.extensionContext;
  }
  [self processRequest];
}

- (void)processRequest {
  @synchronized(self) {
    if (self.started) {
      return;
    }
    self.started = YES;
  }
  NSExtensionContext *context = self.shareContext;
  if (!context) {
    NSLog(@"Carrier Share: no extension context");
    return;
  }

  NSString *inboxId = nil;
  NSURL *inbox = [self makeInboxDirectory:&inboxId];
  if (!inbox) {
    [context cancelRequestWithError:[NSError errorWithDomain:@"carrier.share"
                                                        code:1
                                                    userInfo:nil]];
    return;
  }

  dispatch_group_t group = dispatch_group_create();
  __block NSUInteger copied = 0;
  NSUInteger index = 0;
  for (NSExtensionItem *item in context.inputItems) {
    for (NSItemProvider *provider in item.attachments) {
      NSUInteger providerIndex = index++;
      dispatch_group_enter(group);
      if ([provider hasItemConformingToTypeIdentifier:@"public.file-url"]) {
        [provider loadItemForTypeIdentifier:@"public.file-url"
                                    options:nil
                          completionHandler:^(id<NSSecureCoding> loaded, NSError *error) {
                            NSURL *source = nil;
                            if ([(NSObject *)loaded isKindOfClass:[NSURL class]]) {
                              source = (NSURL *)loaded;
                            } else if ([(NSObject *)loaded isKindOfClass:[NSData class]]) {
                              source = [NSURL URLWithDataRepresentation:(NSData *)loaded
                                                          relativeToURL:nil];
                            }
                            if (source.isFileURL) {
                              NSString *name = [self inboxNameForIndex:providerIndex
                                                         suggestedName:source.lastPathComponent
                                                              fallback:nil];
                              NSURL *destination =
                                  [inbox URLByAppendingPathComponent:name isDirectory:NO];
                              if ([[NSFileManager defaultManager] copyItemAtURL:source
                                                                          toURL:destination
                                                                          error:nil]) {
                                copied += 1;
                              }
                            }
                            dispatch_group_leave(group);
                          }];
      } else if ([provider hasItemConformingToTypeIdentifier:@"public.data"]) {
        [provider loadItemForTypeIdentifier:@"public.data"
                                    options:nil
                          completionHandler:^(id<NSSecureCoding> loaded, NSError *error) {
                            if ([(NSObject *)loaded isKindOfClass:[NSData class]]) {
                              NSString *extension =
                                  provider.registeredTypeIdentifiers.firstObject
                                      ? [self extensionForType:provider.registeredTypeIdentifiers
                                                                   .firstObject]
                                      : nil;
                              NSString *name = [self inboxNameForIndex:providerIndex
                                                         suggestedName:nil
                                                              fallback:extension];
                              NSURL *destination =
                                  [inbox URLByAppendingPathComponent:name isDirectory:NO];
                              if ([(NSData *)loaded writeToURL:destination atomically:YES]) {
                                copied += 1;
                              }
                            }
                            dispatch_group_leave(group);
                          }];
      } else {
        dispatch_group_leave(group);
      }
    }
  }

  dispatch_group_notify(group, dispatch_get_main_queue(), ^{
    NSLog(@"Carrier Share: copied %lu attachment(s)", (unsigned long)copied);
    if (copied == 0) {
      [context cancelRequestWithError:[NSError errorWithDomain:@"carrier.share"
                                                          code:2
                                                      userInfo:nil]];
      return;
    }
    NSString *handoff =
        [NSString stringWithFormat:@"%@://share-inbox/%@", kCarrierShareScheme, inboxId];
    BOOL opened = [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:handoff]];
    NSLog(@"Carrier Share: handoff open %@", opened ? @"succeeded" : @"FAILED");
    [context completeRequestReturningItems:@[] completionHandler:nil];
  });
}

- (NSString *)extensionForType:(NSString *)typeIdentifier {
  CFStringRef ext = UTTypeCopyPreferredTagWithClass((__bridge CFStringRef)typeIdentifier,
                                                    kUTTagClassFilenameExtension);
  return ext ? (__bridge_transfer NSString *)ext : nil;
}

@end
